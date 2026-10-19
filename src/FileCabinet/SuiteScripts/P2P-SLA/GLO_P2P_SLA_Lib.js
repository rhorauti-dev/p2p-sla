/**
 * GLO_P2P_SLA_Lib.js
 *
 * Regra do painel de SLA do procure-to-pay. Funcoes puras: recebem as linhas
 * que o Suitelet le por SuiteQL e devolvem os ciclos e os agregados. Nao chama
 * modulo N/, por isso roda inteira no teste (node --test).
 *
 * Ciclo = um par (Requisicao, Pedido de compra). Requisicao sem pedido vira um
 * ciclo com po = null. Marcos do ciclo:
 *
 *   req_criada   createddate da Requisicao
 *   req_aprovada primeira saida do status "Aprovacao do supervisor pendente"
 *                (systemnote TRANDOC.KSTATUS); sem esse status = aprovacao automatica
 *   po_criado    createddate do PO
 *   po_aprovado  idem, no PO
 *   recebido     trandate do primeiro Recebimento do PO
 *   nf_lancada   createddate da primeira Conta a pagar do PO
 *   pago         trandate do ultimo Pagamento, quando todas as contas estao pagas
 *
 * Etapas medem em dias uteis (sabado, domingo e feriados da configuracao fora).
 * Pagamento nao mede duracao contra SLA: compara a data do pagamento com o
 * vencimento da conta, mais a tolerancia.
 *
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([], () => {

    const DIA = 86400000

    const ETAPAS = [
        { id: 'aprovacao_req', nome: 'Aprovação da requisição', responsavel: 'Gestor do departamento', de: 'req_criada', ate: 'req_aprovada' },
        { id: 'emissao_po', nome: 'Emissão do pedido', responsavel: 'Compras', de: 'req_aprovada', ate: 'po_criado' },
        { id: 'aprovacao_po', nome: 'Aprovação do pedido', responsavel: 'Aprovador do pedido', de: 'po_criado', ate: 'po_aprovado' },
        { id: 'entrega', nome: 'Entrega do fornecedor', responsavel: 'Fornecedor / Compras', de: 'po_aprovado', ate: 'recebido' },
        { id: 'lancamento', nome: 'Lançamento da NF', responsavel: 'Fiscal / Contas a pagar', de: 'recebido', ate: 'nf_lancada' },
        { id: 'pagamento', nome: 'Pagamento', responsavel: 'Financeiro', de: 'nf_lancada', ate: 'pago' }
    ]

    // Dias uteis por etapa. Pagamento = tolerancia apos o vencimento.
    const SLA_PADRAO = { aprovacao_req: 2, emissao_po: 3, aprovacao_po: 2, entrega: 15, lancamento: 3, pagamento: 0 }

    // Texto do status vem no idioma da conta: casar pelos dois.
    const RE_APROVACAO_PENDENTE = /aprova[cç][aã]o.*pendente|pending.*approval/i
    const RE_REJEITADO = /rejeit|reject/i

    // Codigos de status (transaction.status) medidos na conta em 19/10/2026.
    const STATUS = {
        reqRejeitada: 'R', reqFechada: 'H',
        poRejeitado: 'C', poFechado: 'H',
        contaPaga: 'B'
    }

    function paraData(iso) {
        if (!iso) return null
        const s = String(iso)
        const d = new Date(s.length <= 10 ? s + 'T00:00:00Z' : s.replace(' ', 'T') + 'Z')
        return isNaN(d.getTime()) ? null : d
    }

    function isoDia(d) { return d.toISOString().slice(0, 10) }

    /** Dias uteis fracionados entre dois instantes; negativo vira 0. */
    function diasUteis(inicio, fim, feriados) {
        const a = paraData(inicio)
        const b = paraData(fim)
        if (!a || !b || b <= a) return 0
        const folga = feriados instanceof Set ? feriados : new Set(feriados || [])
        let ms = 0
        let cursor = a.getTime()
        const final = b.getTime()
        while (cursor < final) {
            const dia = new Date(cursor)
            const fimDoDia = Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate()) + DIA
            const ate = Math.min(fimDoDia, final)
            const semana = dia.getUTCDay()
            if (semana !== 0 && semana !== 6 && !folga.has(isoDia(dia))) ms += ate - cursor
            cursor = ate
        }
        return Math.round((ms / DIA) * 100) / 100
    }

    function diasCorridos(inicio, fim) {
        const a = paraData(inicio)
        const b = paraData(fim)
        if (!a || !b || b <= a) return 0
        return Math.round(((b - a) / DIA) * 100) / 100
    }

    /**
     * Configuracao do deployment (JSON) sobre o padrao.
     * Precedencia: padrao < etapas < prioridade[id] < departamento[id].
     */
    function lerConfig(texto) {
        let cfg = {}
        if (texto) {
            try { cfg = JSON.parse(texto) || {} } catch (e) { cfg = { erro: 'Configuração de SLA inválida: ' + e.message } }
        }
        return {
            etapas: Object.assign({}, SLA_PADRAO, cfg.etapas || {}),
            prioridade: cfg.prioridade || {},
            departamento: cfg.departamento || {},
            feriados: Array.isArray(cfg.feriados) ? cfg.feriados : [],
            erro: cfg.erro || null
        }
    }

    function slaPara(config, deptoId, prioridadeId) {
        return Object.assign({},
            config.etapas,
            config.prioridade[String(prioridadeId)] || {},
            config.departamento[String(deptoId)] || {})
    }

    /**
     * Le as mudancas de status de um documento e devolve quando saiu da
     * aprovacao. Sem nenhuma nota de aprovacao pendente = aprovado na criacao.
     */
    function analisarAprovacao(notas, criadoEm) {
        const ordenadas = (notas || []).slice().sort((x, y) => String(x.quando).localeCompare(String(y.quando)))
        const passouPorAprovacao = ordenadas.some((n) => RE_APROVACAO_PENDENTE.test(n.para || '') || RE_APROVACAO_PENDENTE.test(n.de || ''))
        const reaprovacoes = ordenadas.filter((n) => n.de && RE_APROVACAO_PENDENTE.test(n.para || '')).length
        if (!passouPorAprovacao) return { situacao: 'automatica', quando: criadoEm || null, quem: null, reaprovacoes: 0 }
        for (const n of ordenadas) {
            if (!RE_APROVACAO_PENDENTE.test(n.de || '')) continue
            if (RE_REJEITADO.test(n.para || '')) return { situacao: 'rejeitada', quando: n.quando, quem: n.quem, reaprovacoes }
            if (!RE_APROVACAO_PENDENTE.test(n.para || '')) return { situacao: 'aprovada', quando: n.quando, quem: n.quem, reaprovacoes }
        }
        return { situacao: 'pendente', quando: null, quem: null, reaprovacoes }
    }

    function agrupar(linhas, chave) {
        const m = new Map()
        for (const l of linhas || []) {
            const k = String(l[chave])
            if (!m.has(k)) m.set(k, [])
            m.get(k).push(l)
        }
        return m
    }

    function menor(valores) {
        const v = valores.filter(Boolean).sort()
        return v.length ? v[0] : null
    }

    function maior(valores) {
        const v = valores.filter(Boolean).sort()
        return v.length ? v[v.length - 1] : null
    }

    function medirEtapa(inicio, fim, sla, hoje, feriados) {
        if (!inicio) return { situacao: 'pendente', dias: null, sla }
        if (!fim) {
            const dias = diasUteis(inicio, hoje, feriados)
            return { situacao: dias > sla ? 'atrasada' : 'andamento', dias, sla, inicio, fim: null }
        }
        const dias = diasUteis(inicio, fim, feriados)
        return { situacao: dias <= sla ? 'no_prazo' : 'fora_prazo', dias, sla, inicio, fim }
    }

    /**
     * Pagamento: cada conta a pagar contra o proprio vencimento.
     * Conta paga depois do vencimento + tolerancia = fora do prazo; conta
     * aberta com vencimento passado = atrasada (sem baixa no NetSuite).
     */
    function medirPagamento(contas, tolerancia, hoje, feriados) {
        if (!contas.length) return { situacao: 'pendente', dias: null, sla: tolerancia, contas: [] }
        const detalhe = contas.map((c) => {
            const limite = c.vencimento
            const atraso = c.pago ? diasUteis(limite, c.pago, feriados) : diasUteis(limite, hoje, feriados)
            let situacao
            if (c.pago) situacao = atraso <= tolerancia ? 'no_prazo' : 'fora_prazo'
            else situacao = limite && atraso > tolerancia ? 'atrasada' : 'andamento'
            return Object.assign({}, c, { atraso, situacao })
        })
        const todasPagas = detalhe.every((c) => c.pago)
        const inicio = menor(contas.map((c) => c.criada))
        const fim = todasPagas ? maior(detalhe.map((c) => c.pago)) : null
        let situacao
        if (todasPagas) situacao = detalhe.some((c) => c.situacao === 'fora_prazo') ? 'fora_prazo' : 'no_prazo'
        else situacao = detalhe.some((c) => c.situacao === 'atrasada') ? 'atrasada' : 'andamento'
        return {
            situacao, sla: tolerancia, inicio, fim,
            dias: diasUteis(inicio, fim || hoje, feriados),
            atrasoMaximo: Math.max.apply(null, detalhe.map((c) => c.atraso)),
            vencimento: maior(contas.map((c) => c.vencimento)),
            semBaixa: detalhe.filter((c) => !c.pago && c.situacao === 'atrasada').length,
            contas: detalhe
        }
    }

    /**
     * Monta os ciclos a partir das linhas lidas.
     * dados = { reqs, reqNotas, pos, poNotas, recebimentos, contas, pagamentos }
     */
    function montarCiclos(dados, config, hoje) {
        const feriados = new Set(config.feriados)
        const notasReq = agrupar(dados.reqNotas, 'doc')
        const notasPo = agrupar(dados.poNotas, 'doc')
        const posDaReq = agrupar(dados.pos, 'req_id')
        const recDoPo = agrupar(dados.recebimentos, 'po_id')
        const contasDoPo = agrupar(dados.contas, 'po_id')
        const pagDaConta = agrupar(dados.pagamentos, 'conta_id')

        const ciclos = []
        for (const req of dados.reqs || []) {
            const sla = slaPara(config, req.depto_id, req.prioridade_id)
            const aprovReq = analisarAprovacao(notasReq.get(String(req.id)), req.criada)
            const pos = posDaReq.get(String(req.id)) || [null]
            pos.forEach((po, i) => {
                const marcos = { req_criada: req.criada, req_aprovada: null, po_criado: null, po_aprovado: null, recebido: null, nf_lancada: null, pago: null }
                if (aprovReq.situacao === 'aprovada' || aprovReq.situacao === 'automatica') marcos.req_aprovada = aprovReq.quando

                let aprovPo = null
                let recebimentos = []
                let contas = []
                if (po) {
                    marcos.po_criado = po.criado
                    aprovPo = analisarAprovacao(notasPo.get(String(po.id)), po.criado)
                    if (aprovPo.situacao === 'aprovada' || aprovPo.situacao === 'automatica') marcos.po_aprovado = aprovPo.quando
                    recebimentos = (recDoPo.get(String(po.id)) || []).slice().sort((x, y) => String(x.data).localeCompare(String(y.data)))
                    marcos.recebido = recebimentos.length ? recebimentos[0].data : null
                    contas = (contasDoPo.get(String(po.id)) || []).map((c) => {
                        const pags = pagDaConta.get(String(c.id)) || []
                        const paga = String(c.status) === STATUS.contaPaga
                        return {
                            id: c.id, tranid: c.tranid, criada: c.criada, vencimento: c.vencimento, total: Number(c.total) || 0,
                            pago: paga ? maior(pags.map((p) => p.data)) || null : null,
                            pagamentos: pags.map((p) => ({ id: p.id, tranid: p.tranid, data: p.data }))
                        }
                    })
                    marcos.nf_lancada = menor(contas.map((c) => c.criada))
                }

                // Servico (sem recebimento) com NF lancada: entrega nao se aplica e o
                // lancamento passa a contar da aprovacao do pedido.
                const servico = Boolean(po) && !recebimentos.length && contas.length > 0
                const etapas = {}
                etapas.aprovacao_req = aprovReq.situacao === 'rejeitada'
                    ? { situacao: 'rejeitada', dias: diasUteis(req.criada, aprovReq.quando, feriados), sla: sla.aprovacao_req }
                    : medirEtapa(marcos.req_criada, marcos.req_aprovada, sla.aprovacao_req, hoje, feriados)
                etapas.aprovacao_req.automatica = aprovReq.situacao === 'automatica'
                etapas.aprovacao_req.quem = aprovReq.quem
                etapas.aprovacao_req.reaprovacoes = aprovReq.reaprovacoes

                const reqParada = !po && (String(req.status) === STATUS.reqFechada || String(req.status) === STATUS.reqRejeitada)
                etapas.emissao_po = reqParada
                    ? { situacao: 'encerrada', dias: null, sla: sla.emissao_po }
                    : medirEtapa(marcos.req_aprovada, marcos.po_criado, sla.emissao_po, hoje, feriados)

                if (aprovPo && aprovPo.situacao === 'rejeitada') {
                    etapas.aprovacao_po = { situacao: 'rejeitada', dias: diasUteis(po.criado, aprovPo.quando, feriados), sla: sla.aprovacao_po }
                } else {
                    etapas.aprovacao_po = medirEtapa(marcos.po_criado, marcos.po_aprovado, sla.aprovacao_po, hoje, feriados)
                }
                etapas.aprovacao_po.automatica = Boolean(aprovPo) && aprovPo.situacao === 'automatica'
                etapas.aprovacao_po.quem = aprovPo ? aprovPo.quem : null
                etapas.aprovacao_po.reaprovacoes = aprovPo ? aprovPo.reaprovacoes : 0

                const poParado = Boolean(po) && (String(po.status) === STATUS.poFechado || String(po.status) === STATUS.poRejeitado)
                if (servico) etapas.entrega = { situacao: 'nao_se_aplica', dias: null, sla: sla.entrega }
                else if (poParado && !marcos.recebido) etapas.entrega = { situacao: 'encerrada', dias: null, sla: sla.entrega }
                else etapas.entrega = medirEtapa(marcos.po_aprovado, marcos.recebido, sla.entrega, hoje, feriados)

                const inicioLancamento = servico ? marcos.po_aprovado : marcos.recebido
                etapas.lancamento = poParado && !marcos.nf_lancada
                    ? { situacao: 'encerrada', dias: null, sla: sla.lancamento }
                    : medirEtapa(inicioLancamento, marcos.nf_lancada, sla.lancamento, hoje, feriados)
                etapas.lancamento.desdeAprovacao = servico

                etapas.pagamento = medirPagamento(contas, sla.pagamento, hoje, feriados)
                if (etapas.pagamento.situacao === 'no_prazo' || etapas.pagamento.situacao === 'fora_prazo') marcos.pago = etapas.pagamento.fim

                const ordem = ETAPAS.map((e) => e.id)
                const parada = ordem.find((id) => ['rejeitada', 'encerrada'].indexOf(etapas[id].situacao) >= 0)
                let situacao
                if (parada) situacao = etapas[parada].situacao === 'rejeitada' ? 'rejeitado' : 'encerrado'
                else if (marcos.pago) situacao = 'concluido'
                else situacao = 'andamento'
                const etapaAtual = situacao === 'andamento'
                    ? ordem.find((id) => ['andamento', 'atrasada'].indexOf(etapas[id].situacao) >= 0) || null
                    : null

                const concluidas = ordem.filter((id) => ['no_prazo', 'fora_prazo'].indexOf(etapas[id].situacao) >= 0)
                ciclos.push({
                    chave: req.id + '-' + (po ? po.id : '0'),
                    primeiroDaReq: i === 0,
                    req: {
                        id: req.id, tranid: req.tranid, criada: req.criada, status: req.status, statusNome: req.status_nome,
                        solicitante: req.solicitante, depto_id: req.depto_id, depto: req.depto || 'Sem departamento',
                        sub_id: req.sub_id, subsidiaria: req.subsidiaria, prioridade_id: req.prioridade_id,
                        prioridade: req.prioridade || 'Sem prioridade', total: Number(req.total) || 0, memo: req.memo
                    },
                    po: po ? {
                        id: po.id, tranid: po.tranid, criado: po.criado, status: po.status, statusNome: po.status_nome,
                        fornecedor: po.fornecedor, comprador: po.comprador, total: Number(po.total) || 0
                    } : null,
                    recebimentos: recebimentos.map((r) => ({ id: r.id, tranid: r.tranid, data: r.data })),
                    contas: etapas.pagamento.contas || [],
                    marcos, etapas, servico, situacao, etapaAtual,
                    noSla: concluidas.length > 0 && concluidas.every((id) => etapas[id].situacao === 'no_prazo') &&
                        !ordem.some((id) => etapas[id].situacao === 'atrasada'),
                    leadUteis: marcos.pago ? diasUteis(marcos.req_criada, marcos.pago, feriados) : null,
                    leadCorridos: marcos.pago ? diasCorridos(marcos.req_criada, marcos.pago) : null,
                    idadeUteis: diasUteis(marcos.req_criada, marcos.pago || hoje, feriados)
                })
            })
        }
        return ciclos
    }

    function filtrar(ciclos, filtros) {
        const f = filtros || {}
        return ciclos.filter((c) =>
            (!f.depto || String(c.req.depto_id) === String(f.depto)) &&
            (!f.sub || String(c.req.sub_id) === String(f.sub)) &&
            (!f.prioridade || String(c.req.prioridade_id) === String(f.prioridade)) &&
            (!f.situacao || c.situacao === f.situacao))
    }

    function estatistica(valores) {
        const v = valores.filter((x) => typeof x === 'number' && !isNaN(x)).sort((a, b) => a - b)
        if (!v.length) return { n: 0, media: null, mediana: null, p90: null, max: null }
        const pos = (p) => {
            const i = (v.length - 1) * p
            const b = Math.floor(i)
            return v[b] + (v[Math.min(b + 1, v.length - 1)] - v[b]) * (i - b)
        }
        const r = (x) => Math.round(x * 10) / 10
        return { n: v.length, media: r(v.reduce((s, x) => s + x, 0) / v.length), mediana: r(pos(0.5)), p90: r(pos(0.9)), max: r(v[v.length - 1]) }
    }

    // Aprovacao da requisicao conta uma vez por requisicao, nao por pedido.
    function ciclosDaEtapa(ciclos, etapaId) {
        return etapaId === 'aprovacao_req' ? ciclos.filter((c) => c.primeiroDaReq) : ciclos
    }

    function resumoEtapa(ciclos, etapaId) {
        const doEtapa = ciclosDaEtapa(ciclos, etapaId).map((c) => c.etapas[etapaId])
        const concluidas = doEtapa.filter((e) => e.situacao === 'no_prazo' || e.situacao === 'fora_prazo')
        const noPrazo = concluidas.filter((e) => e.situacao === 'no_prazo').length
        const medida = etapaId === 'pagamento' ? concluidas.map((e) => e.atrasoMaximo) : concluidas.map((e) => e.dias)
        return Object.assign(estatistica(medida), {
            concluidas: concluidas.length,
            noPrazo,
            pctNoPrazo: concluidas.length ? Math.round((noPrazo / concluidas.length) * 1000) / 10 : null,
            andamento: doEtapa.filter((e) => e.situacao === 'andamento').length,
            atrasadas: doEtapa.filter((e) => e.situacao === 'atrasada').length
        })
    }

    function ranking(ciclos, etapaId, rotulo) {
        const m = new Map()
        for (const c of ciclosDaEtapa(ciclos, etapaId)) {
            const e = c.etapas[etapaId]
            if (e.situacao !== 'no_prazo' && e.situacao !== 'fora_prazo') continue
            if (e.automatica) continue
            const nome = rotulo(c, e) || 'Não identificado'
            if (!m.has(nome)) m.set(nome, [])
            m.get(nome).push(e)
        }
        return Array.from(m.entries()).map(([nome, lista]) => {
            const est = estatistica(lista.map((e) => e.dias))
            const ok = lista.filter((e) => e.situacao === 'no_prazo').length
            return { nome, n: est.n, media: est.media, mediana: est.mediana, pctNoPrazo: Math.round((ok / lista.length) * 1000) / 10 }
        }).sort((a, b) => b.n - a.n)
    }

    function mes(iso) { return iso ? String(iso).slice(0, 7) : null }

    function agregar(ciclos) {
        const reqs = new Set(ciclos.map((c) => c.req.id))
        const concluidos = ciclos.filter((c) => c.situacao === 'concluido')
        const andamento = ciclos.filter((c) => c.situacao === 'andamento')
        const todasEtapas = []
        for (const c of ciclos) {
            for (const e of ETAPAS) {
                if (e.id === 'aprovacao_req' && !c.primeiroDaReq) continue
                todasEtapas.push(c.etapas[e.id])
            }
        }
        const concluidasTodas = todasEtapas.filter((e) => e.situacao === 'no_prazo' || e.situacao === 'fora_prazo')
        const lead = estatistica(concluidos.map((c) => c.leadUteis))

        const porEtapa = ETAPAS.map((e) => Object.assign({ id: e.id, nome: e.nome, responsavel: e.responsavel }, resumoEtapa(ciclos, e.id)))

        const deptos = Array.from(new Set(ciclos.map((c) => c.req.depto))).sort()
        const porDepto = deptos.map((d) => {
            const doDepto = ciclos.filter((c) => c.req.depto === d)
            const etapas = {}
            ETAPAS.forEach((e) => { etapas[e.id] = resumoEtapa(doDepto, e.id) })
            const conc = doDepto.filter((c) => c.situacao === 'concluido')
            return {
                depto: d,
                requisicoes: new Set(doDepto.map((c) => c.req.id)).size,
                ciclos: doDepto.length,
                valor: doDepto.reduce((s, c) => s + (c.po ? c.po.total : 0), 0),
                leadMediana: estatistica(conc.map((c) => c.leadUteis)).mediana,
                idadeMediana: estatistica(doDepto.filter((c) => c.situacao === 'andamento').map((c) => c.idadeUteis)).mediana,
                etapas
            }
        }).sort((a, b) => b.ciclos - a.ciclos)

        const meses = Array.from(new Set(ciclos.map((c) => mes(c.req.criada)).filter(Boolean))).sort()
        const mensal = meses.map((m) => {
            const doMes = ciclos.filter((c) => mes(c.req.criada) === m)
            const etapas = {}
            ETAPAS.forEach((e) => {
                const r = resumoEtapa(doMes, e.id)
                etapas[e.id] = { mediana: r.mediana, media: r.media, pctNoPrazo: r.pctNoPrazo }
            })
            return {
                mes: m,
                requisicoes: new Set(doMes.map((c) => c.req.id)).size,
                leadMediana: estatistica(doMes.filter((c) => c.situacao === 'concluido').map((c) => c.leadUteis)).mediana,
                etapas
            }
        })

        const faixas = [[0, 5], [5, 10], [10, 20], [20, 30], [30, 45], [45, 60], [60, 90], [90, Infinity]]
        const histograma = faixas.map(([a, b]) => ({
            faixa: b === Infinity ? a + '+' : a + '–' + b,
            qtd: concluidos.filter((c) => c.leadUteis >= a && c.leadUteis < b).length
        }))

        const etapaAtual = ETAPAS.map((e) => ({
            id: e.id, nome: e.nome,
            noPrazo: andamento.filter((c) => c.etapaAtual === e.id && c.etapas[e.id].situacao === 'andamento').length,
            atrasadas: andamento.filter((c) => c.etapaAtual === e.id && c.etapas[e.id].situacao === 'atrasada').length
        }))

        const fornecedores = ranking(ciclos.filter((c) => c.po), 'entrega', (c) => c.po.fornecedor)
        return {
            kpis: {
                requisicoes: reqs.size,
                ciclos: ciclos.length,
                concluidos: concluidos.length,
                andamento: andamento.length,
                rejeitados: ciclos.filter((c) => c.situacao === 'rejeitado').length,
                encerrados: ciclos.filter((c) => c.situacao === 'encerrado').length,
                leadMedia: lead.media,
                leadMediana: lead.mediana,
                leadP90: lead.p90,
                etapasConcluidas: concluidasTodas.length,
                pctEtapasNoPrazo: concluidasTodas.length
                    ? Math.round((concluidasTodas.filter((e) => e.situacao === 'no_prazo').length / concluidasTodas.length) * 1000) / 10 : null,
                atrasadasAgora: todasEtapas.filter((e) => e.situacao === 'atrasada').length,
                valorPedidos: ciclos.reduce((s, c) => s + (c.po ? c.po.total : 0), 0),
                contasSemBaixa: ciclos.reduce((s, c) => s + (c.etapas.pagamento.semBaixa || 0), 0),
                contasPagas: ciclos.reduce((s, c) => s + c.contas.filter((x) => x.pago).length, 0),
                contas: ciclos.reduce((s, c) => s + c.contas.length, 0)
            },
            porEtapa, porDepto, mensal, histograma, etapaAtual,
            rankings: {
                aprovadoresReq: ranking(ciclos, 'aprovacao_req', (c, e) => e.quem),
                compradores: ranking(ciclos.filter((c) => c.po), 'emissao_po', (c) => c.po.comprador),
                aprovadoresPo: ranking(ciclos.filter((c) => c.po), 'aprovacao_po', (c, e) => e.quem),
                fornecedores: fornecedores.slice(0, 15)
            }
        }
    }

    return {
        ETAPAS, SLA_PADRAO, STATUS,
        diasUteis, diasCorridos, lerConfig, slaPara, analisarAprovacao,
        medirEtapa, medirPagamento, montarCiclos, filtrar, estatistica, agregar
    }
})
