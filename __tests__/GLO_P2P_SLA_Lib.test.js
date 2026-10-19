/**
 * Falsificador da regra do painel de SLA do procure-to-pay.
 *
 *   node --test "__tests__/*.test.js"
 *
 * O que quebra em silencio se mudar: fim de semana contando como dia util, a
 * data de aprovacao lida da nota errada, aprovacao automatica virando
 * "pendente", servico (sem recebimento) travando o ciclo, conta aberta e
 * vencida contando como paga, e a aprovacao da requisicao contada uma vez por
 * pedido em vez de uma vez por requisicao.
 */
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const LIB = path.join(__dirname, '..', 'src', 'FileCabinet', 'SuiteScripts', 'P2P-SLA', 'GLO_P2P_SLA_Lib.js')

function carregar(arquivo, deps) {
    let exportado = null
    const sandbox = {
        console, JSON, Math, Object, Array, String, Number, Error, Set, Map, Date, isNaN, Infinity,
        define(nomes, factory) { exportado = factory.apply(null, nomes.map((n) => (deps && deps[n]) || {})) }
    }
    vm.createContext(sandbox)
    vm.runInContext(fs.readFileSync(arquivo, 'utf8'), sandbox, { filename: arquivo })
    return exportado
}

const lib = carregar(LIB)
const j = (x) => JSON.parse(JSON.stringify(x))
const CFG = lib.lerConfig('')
const HOJE = '2026-10-19T12:00:00'

// 2026-10-16 = sexta, 2026-10-19 = segunda.
test('dias uteis: fim de semana nao conta', () => {
    assert.equal(lib.diasUteis('2026-10-16T16:00:00', '2026-10-19T10:00:00'), 0.75)
    assert.equal(lib.diasUteis('2026-10-17T00:00:00', '2026-10-19T00:00:00'), 0)
    assert.equal(lib.diasUteis('2026-10-12T00:00:00', '2026-10-19T00:00:00'), 5)
})

test('dias uteis: feriado nao conta e fim antes do inicio vira zero', () => {
    assert.equal(lib.diasUteis('2026-11-02', '2026-11-04', ['2026-11-02']), 1)
    assert.equal(lib.diasUteis('2026-10-19', '2026-10-12'), 0)
    assert.equal(lib.diasUteis(null, '2026-10-12'), 0)
})

test('configuracao: departamento vence prioridade, que vence o geral', () => {
    const cfg = lib.lerConfig(JSON.stringify({
        etapas: { entrega: 20 },
        prioridade: { 1: { entrega: 5, emissao_po: 1 } },
        departamento: { 38: { entrega: 10 } }
    }))
    assert.deepEqual(j(lib.slaPara(cfg, 38, 1)), Object.assign({}, j(lib.SLA_PADRAO), { entrega: 10, emissao_po: 1 }))
    assert.equal(lib.slaPara(cfg, 99, 1).entrega, 5)
    assert.equal(lib.slaPara(cfg, 99, 3).entrega, 20)
})

test('configuracao invalida cai no padrao e avisa', () => {
    const cfg = lib.lerConfig('{nao e json')
    assert.match(cfg.erro, /inválida/)
    assert.deepEqual(j(cfg.etapas), j(lib.SLA_PADRAO))
})

const nota = (quando, de, para, quem) => ({ quando, de, para, quem: quem || 'Fulano' })

test('aprovacao: primeira saida do status pendente, com quem aprovou', () => {
    const r = lib.analisarAprovacao([
        nota('2026-10-07T12:08:00', 'Aprovação do supervisor pendente', 'Pedido pendente', 'Lelius Braga'),
        nota('2026-10-06T16:14:00', '', 'Aprovação do supervisor pendente', 'Leonardo')
    ], '2026-10-06T16:14:00')
    assert.equal(r.situacao, 'aprovada')
    assert.equal(r.quando, '2026-10-07T12:08:00')
    assert.equal(r.quem, 'Lelius Braga')
})

test('aprovacao: documento que nasce aprovado e automatico, nao pendente', () => {
    const r = lib.analisarAprovacao([nota('2026-10-06T16:14:00', '', 'Pedido pendente')], '2026-10-06T16:14:00')
    assert.equal(r.situacao, 'automatica')
    assert.equal(r.quando, '2026-10-06T16:14:00')
})

test('aprovacao: rejeicao, pendencia e texto em ingles', () => {
    assert.equal(lib.analisarAprovacao([nota('2026-01-01T10:00:00', '', 'Aprovação do supervisor pendente'),
        nota('2026-01-02T10:00:00', 'Aprovação do supervisor pendente', 'Rejeitado')]).situacao, 'rejeitada')
    assert.equal(lib.analisarAprovacao([nota('2026-01-01T10:00:00', '', 'Aprovação do supervisor pendente')]).situacao, 'pendente')
    assert.equal(lib.analisarAprovacao([nota('2026-01-01T10:00:00', '', 'Pending Supervisor Approval'),
        nota('2026-01-03T10:00:00', 'Pending Supervisor Approval', 'Pending Receipt')]).situacao, 'aprovada')
})

test('aprovacao: volta para aprovacao depois de editado conta como reaprovacao', () => {
    const r = lib.analisarAprovacao([
        nota('2026-01-01T10:00:00', '', 'Aprovação do supervisor pendente'),
        nota('2026-01-02T10:00:00', 'Aprovação do supervisor pendente', 'Recebimento pendente'),
        nota('2026-01-05T10:00:00', 'Recebimento pendente', 'Aprovação do supervisor pendente'),
        nota('2026-01-06T10:00:00', 'Aprovação do supervisor pendente', 'Recebimento pendente')
    ])
    assert.equal(r.quando, '2026-01-02T10:00:00')
    assert.equal(r.reaprovacoes, 1)
})

test('pagamento: pago no vencimento, pago atrasado, aberto vencido sem baixa', () => {
    const ok = lib.medirPagamento([{ criada: '2026-09-01T10:00:00', vencimento: '2026-09-30', pago: '2026-09-30' }], 0, HOJE, [])
    assert.equal(ok.situacao, 'no_prazo')
    const atrasado = lib.medirPagamento([{ criada: '2026-09-01T10:00:00', vencimento: '2026-09-30', pago: '2026-10-02' }], 0, HOJE, [])
    assert.equal(atrasado.situacao, 'fora_prazo')
    assert.equal(atrasado.atrasoMaximo, 2)
    const semBaixa = lib.medirPagamento([{ criada: '2026-09-01T10:00:00', vencimento: '2026-09-30', pago: null }], 0, HOJE, [])
    assert.equal(semBaixa.situacao, 'atrasada')
    assert.equal(semBaixa.semBaixa, 1)
    const aVencer = lib.medirPagamento([{ criada: '2026-10-01T10:00:00', vencimento: '2026-11-30', pago: null }], 0, HOJE, [])
    assert.equal(aVencer.situacao, 'andamento')
    assert.equal(aVencer.semBaixa, 0)
})

// Cenario completo: REQ 1 (Engenharia) com dois pedidos, um de material e um de servico;
// REQ 2 aprovada sem pedido; REQ 3 rejeitada.
function dados() {
    return {
        reqs: [
            { id: 1, tranid: '500', criada: '2026-09-01T09:00:00', status: 'E', depto_id: 10, depto: 'Engenharia', prioridade_id: 1, prioridade: 'Alta', sub_id: 4, solicitante: 'Ana', total: 100 },
            { id: 2, tranid: '501', criada: '2026-10-12T09:00:00', status: 'B', depto_id: 20, depto: 'RH', prioridade_id: 2, prioridade: 'Média', sub_id: 4, solicitante: 'Bia', total: 50 },
            { id: 3, tranid: '502', criada: '2026-10-01T09:00:00', status: 'R', depto_id: 20, depto: 'RH', prioridade_id: 2, prioridade: 'Média', sub_id: 4, solicitante: 'Bia', total: 10 }
        ],
        reqNotas: [
            { doc: 1, quando: '2026-09-01T09:00:00', de: '', para: 'Aprovação do supervisor pendente', quem: 'Ana' },
            { doc: 1, quando: '2026-09-02T09:00:00', de: 'Aprovação do supervisor pendente', para: 'Pedido pendente', quem: 'Gestor' },
            { doc: 2, quando: '2026-10-12T09:00:00', de: '', para: 'Pedido pendente', quem: 'Bia' },
            { doc: 3, quando: '2026-10-01T09:00:00', de: '', para: 'Aprovação do supervisor pendente', quem: 'Bia' },
            { doc: 3, quando: '2026-10-02T09:00:00', de: 'Aprovação do supervisor pendente', para: 'Rejeitado', quem: 'Gestor' }
        ],
        pos: [
            { req_id: 1, id: 11, tranid: 'PO1', criado: '2026-09-03T09:00:00', status: 'G', fornecedor: 'F1', comprador: 'Glaucia', total: 1000 },
            { req_id: 1, id: 12, tranid: 'PO2', criado: '2026-09-04T09:00:00', status: 'F', fornecedor: 'F2', comprador: 'Glaucia', total: 500 }
        ],
        poNotas: [
            { doc: 11, quando: '2026-09-03T09:00:00', de: '', para: 'Aprovação do supervisor pendente', quem: 'Glaucia' },
            { doc: 11, quando: '2026-09-04T09:00:00', de: 'Aprovação do supervisor pendente', para: 'Recebimento pendente', quem: 'Diretor' },
            { doc: 12, quando: '2026-09-04T09:00:00', de: '', para: 'Recebimento pendente', quem: 'Glaucia' }
        ],
        recebimentos: [{ po_id: 11, id: 21, tranid: 'IR1', data: '2026-09-14' }],
        contas: [
            { po_id: 11, id: 31, criada: '2026-09-15T09:00:00', vencimento: '2026-09-30', status: 'B', total: 1000 },
            { po_id: 12, id: 32, criada: '2026-09-10T09:00:00', vencimento: '2026-09-25', status: 'A', total: 500 }
        ],
        pagamentos: [{ conta_id: 31, id: 41, tranid: 'PG1', data: '2026-09-29' }]
    }
}

test('ciclo completo: marcos, etapas e lead time', () => {
    const ciclos = lib.montarCiclos(dados(), CFG, HOJE)
    const c = ciclos.find((x) => x.chave === '1-11')
    assert.equal(c.marcos.req_aprovada, '2026-09-02T09:00:00')
    assert.equal(c.marcos.po_aprovado, '2026-09-04T09:00:00')
    assert.equal(c.marcos.recebido, '2026-09-14')
    assert.equal(c.marcos.pago, '2026-09-29')
    assert.equal(c.etapas.aprovacao_req.dias, 1)
    assert.equal(c.etapas.aprovacao_req.quem, 'Gestor')
    assert.equal(c.etapas.emissao_po.dias, 1)
    assert.equal(c.etapas.aprovacao_po.quem, 'Diretor')
    assert.equal(c.etapas.entrega.situacao, 'no_prazo')
    assert.equal(c.etapas.pagamento.situacao, 'no_prazo')
    assert.equal(c.situacao, 'concluido')
    assert.equal(c.leadUteis, lib.diasUteis('2026-09-01T09:00:00', '2026-09-29'))
})

test('servico sem recebimento: entrega nao se aplica e lancamento conta da aprovacao', () => {
    const c = lib.montarCiclos(dados(), CFG, HOJE).find((x) => x.chave === '1-12')
    assert.equal(c.servico, true)
    assert.equal(c.etapas.entrega.situacao, 'nao_se_aplica')
    assert.equal(c.etapas.aprovacao_po.automatica, true)
    assert.equal(c.etapas.lancamento.inicio, '2026-09-04T09:00:00')
    assert.equal(c.etapas.pagamento.situacao, 'atrasada')
    assert.equal(c.situacao, 'andamento')
    assert.equal(c.etapaAtual, 'pagamento')
    assert.equal(c.marcos.pago, null)
})

test('requisicao aprovada sem pedido fica parada na emissao; rejeitada encerra', () => {
    const ciclos = lib.montarCiclos(dados(), CFG, HOJE)
    const semPo = ciclos.find((x) => x.chave === '2-0')
    assert.equal(semPo.etapas.aprovacao_req.automatica, true)
    assert.equal(semPo.etapaAtual, 'emissao_po')
    assert.equal(semPo.etapas.emissao_po.situacao, 'atrasada')
    const rej = ciclos.find((x) => x.chave === '3-0')
    assert.equal(rej.situacao, 'rejeitado')
    assert.equal(rej.etapaAtual, null)
})

test('agregados: aprovacao da requisicao conta uma vez por requisicao', () => {
    const ag = lib.agregar(lib.montarCiclos(dados(), CFG, HOJE))
    const aprov = ag.porEtapa.find((e) => e.id === 'aprovacao_req')
    // REQ 1 (1 vez, apesar de 2 pedidos) + REQ 2 automatica; REQ 3 rejeitada nao e concluida.
    assert.equal(aprov.concluidas, 2)
    assert.equal(ag.kpis.requisicoes, 3)
    assert.equal(ag.kpis.ciclos, 4)
    assert.equal(ag.kpis.concluidos, 1)
    assert.equal(ag.kpis.contasSemBaixa, 1)
    assert.equal(ag.kpis.contasPagas, 1)
    assert.equal(ag.rankings.aprovadoresReq.length, 1, 'aprovacao automatica nao entra no ranking')
    assert.equal(ag.rankings.aprovadoresReq[0].nome, 'Gestor')
})

test('agregados: matriz por departamento e etapa atual', () => {
    const ag = lib.agregar(lib.montarCiclos(dados(), CFG, HOJE))
    assert.deepEqual(ag.porDepto.map((d) => d.depto).sort(), ['Engenharia', 'RH'])
    const atual = Object.fromEntries(ag.etapaAtual.map((e) => [e.id, e.noPrazo + e.atrasadas]))
    assert.equal(atual.emissao_po, 1)
    assert.equal(atual.pagamento, 1)
})

test('filtro por departamento e situacao', () => {
    const ciclos = lib.montarCiclos(dados(), CFG, HOJE)
    assert.equal(lib.filtrar(ciclos, { depto: 20 }).length, 2)
    assert.equal(lib.filtrar(ciclos, { situacao: 'concluido' }).length, 1)
})
