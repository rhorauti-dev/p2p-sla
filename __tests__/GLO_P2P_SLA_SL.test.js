/**
 * Falsificador do Suitelet do painel de SLA.
 *
 *   node --test "__tests__/*.test.js"
 *
 * O que quebra em silencio se mudar: o JavaScript da pagina (vive dentro do
 * template literal PAGE_HTML, node --check nao o enxerga), o nome das colunas
 * do SuiteQL que a biblioteca le, o status em codigo (nao o texto) e o aviso de
 * conta vencida sem baixa.
 */
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const DIR = path.join(__dirname, '..', 'src', 'FileCabinet', 'SuiteScripts', 'P2P-SLA')
const SL = path.join(DIR, 'GLO_P2P_SLA_SL.js')
const LIB = path.join(DIR, 'GLO_P2P_SLA_Lib.js')
const fonte = fs.readFileSync(SL, 'utf8')

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

// Linhas como o SuiteQL devolve (asMappedResults), escolhidas pelo texto da consulta.
const LINHAS = {
    reqs: [{ id: 1, tranid: '500', criada: '2026-09-01T09:00:00', status: 'E', status_nome: 'Requisition : Fully Ordered', solicitante: 'Ana', prioridade_id: 1, prioridade: 'Alta', depto_id: 10, depto: 'Engenharia', sub_id: 4, subsidiaria: 'MATRIZ', total: 100, memo: 'x' }],
    reqNotas: [{ doc: 1, quando: '2026-09-02T09:00:00', quem: 'Gestor', de: 'Aprovação do supervisor pendente', para: 'Pedido pendente' }],
    pos: [{ req_id: 1, id: 11, tranid: 'PO1', criado: '2026-09-03T09:00:00', status: 'F', status_nome: 'Purchase Order : Pending Bill', fornecedor: 'F1', comprador: 'Glaucia', total: 1000 }],
    poNotas: [],
    recebimentos: [{ po_id: 11, id: 21, tranid: 'IR1', data: '2026-09-14' }],
    contas: [{ po_id: 11, id: 31, tranid: null, criada: '2026-09-15T09:00:00', vencimento: '2026-09-30', status: 'A', total: 1000 }],
    pagamentos: [],
    bids: [{ id: 1004, name: 'BID-1004', req_id: 1, criado: '2026-09-02T10:00:00', envio: '2026-09-02T11:00:00', rectype: 4583 }],
    convidados: [{ bid_id: 1004, id: 5, respondido: '2026-09-02T15:00:00' }],
    rodadas: []
}

function qualConsulta(sql) {
    if (/customrecord_gl_bid_forn /.test(sql)) return 'convidados'
    if (/customrecord_gl_bid_neg_rodada /.test(sql)) return 'rodadas'
    if (/customrecord_gl_bid /.test(sql)) return 'bids'
    if (/'VendPymt'/.test(sql)) return 'pagamentos'
    if (/'VendBill'/.test(sql)) return 'contas'
    if (/'ItemRcpt'/.test(sql)) return 'recebimentos'
    if (/TRANDOC\.KSTATUS' AND s\.recordid IN \(\d/.test(sql)) return 'poNotas'
    if (/TRANDOC\.KSTATUS/.test(sql)) return 'reqNotas'
    if (/'POrdReq'/.test(sql)) return 'pos'
    return 'reqs'
}

function montarSuitelet(param, falhar) {
    const consultas = []
    const query = {
        runSuiteQLPaged({ query: sql, params }) {
            const nome = qualConsulta(sql)
            consultas.push({ nome, sql, params })
            if (falhar && falhar.test(nome)) throw new Error('Invalid search query: Search error occurred: Record customrecord_gl_bid was not found.')
            const linhas = LINHAS[nome]
            return { pageRanges: [{ index: 0 }], fetch: () => ({ data: { asMappedResults: () => linhas } }) }
        }
    }
    const runtime = { getCurrentScript: () => ({ getRemainingUsage: () => 1000, getParameter: () => param || '' }) }
    const log = { audit() {}, error() {}, debug() {} }
    const sl = carregar(SL, { 'N/query': query, 'N/runtime': runtime, 'N/log': log, './GLO_P2P_SLA_Lib': lib })
    return { sl, consultas }
}

function chamar(sl, parameters) {
    let corpo = ''
    const headers = {}
    sl.onRequest({
        request: { parameters },
        response: { setHeader: (h) => { headers[h.name] = h.value }, write: (s) => { corpo += s } }
    })
    return { corpo, headers }
}

test('pagina: o JavaScript dentro de PAGE_HTML compila', () => {
    const { sl } = montarSuitelet()
    const { corpo, headers } = chamar(sl, {})
    assert.match(headers['Content-Type'], /text\/html/)
    const scripts = [...corpo.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    assert.equal(scripts.length, 1)
    assert.doesNotThrow(() => new vm.Script(scripts[0], { filename: 'pagina.js' }))
    assert.match(corpo, /cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4\.4\.1\//)
})

test('pagina: exporta Excel e PDF, sem CSV, com versao exata das bibliotecas', () => {
    const { sl } = montarSuitelet()
    const { corpo } = chamar(sl, {})
    assert.match(corpo, /id="bt-xlsx"/)
    assert.match(corpo, /id="bt-pdf"/)
    assert.doesNotMatch(corpo, /csv/i)
    assert.match(corpo, /cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.full\.min\.js/)
    assert.match(corpo, /cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/2\.5\.1\/jspdf\.umd\.min\.js/)
    assert.match(corpo, /cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf-autotable\/3\.8\.2\/jspdf\.plugin\.autotable\.min\.js/)
})

test('pagina: o template literal nao interpola nada do script do browser', () => {
    const pagina = fonte.slice(fonte.indexOf('const PAGE_HTML = `'))
    const miolo = pagina.slice(0, pagina.indexOf('</html>`'))
    assert.ok(!miolo.includes('${'), 'interpolacao acidental em PAGE_HTML')
})

test('dados: periodo invalido devolve erro sem consultar', () => {
    const { sl, consultas } = montarSuitelet()
    const r = JSON.parse(chamar(sl, { action: 'dados', de: '01/09/2026', ate: '2026-10-19' }).corpo)
    assert.match(r.erro, /período/)
    assert.equal(consultas.length, 0)
})

test('dados: consulta as dez fontes e devolve ciclo, agregados e aviso de conta sem baixa', () => {
    const { sl, consultas } = montarSuitelet()
    const r = JSON.parse(chamar(sl, { action: 'dados', de: '2026-09-01', ate: '2026-10-19' }).corpo)
    assert.deepEqual(consultas.map((c) => c.nome), ['reqs', 'reqNotas', 'pos', 'bids', 'convidados', 'rodadas', 'poNotas', 'recebimentos', 'contas', 'pagamentos'])
    assert.deepEqual(Array.from(consultas[3].params), ['2026-09-01', '2026-10-19'])
    assert.match(consultas.find((c) => c.nome === 'convidados').sql, /IN \(1004\)/)
    assert.equal(r.ciclos[0].marcos.convites_enviados, '2026-09-02T11:00:00')
    assert.equal(r.ciclos[0].marcos.propostas, '2026-09-02T15:00:00')
    assert.equal(r.ciclos[0].bid.rectype, 4583)
    assert.deepEqual(Array.from(consultas[0].params), ['2026-09-01', '2026-10-19'])
    assert.match(consultas.find((c) => c.nome === 'pagamentos').sql, /IN \(31\)/)
    assert.equal(r.ciclos.length, 1)
    assert.equal(r.ciclos[0].marcos.req_aprovada, '2026-09-02T09:00:00')
    assert.equal(r.ciclos[0].etapas.pagamento.situacao, 'atrasada')
    assert.equal(r.agregados.kpis.contasSemBaixa, 1)
    assert.ok(r.avisos.some((a) => /sem pagamento registrado/.test(a)))
    assert.deepEqual(r.opcoes.deptos, [{ id: '10', nome: 'Engenharia' }])
})

test('dados: status vem em codigo, nao em texto (a regra compara B, H, R)', () => {
    assert.match(fonte, /SELECT t\.id, t\.tranid, TO_CHAR\(t\.createddate, ' \+ F_HORA \+ '\) criada, t\.status,/)
    assert.match(fonte, /'TO_CHAR\(b\.duedate, ' \+ F_DIA \+ '\) vencimento, b\.status,/)
})

test('dados: configuracao do deployment chega a regra', () => {
    const { sl } = montarSuitelet(JSON.stringify({ etapas: { entrega: 1 } }))
    const r = JSON.parse(chamar(sl, { action: 'dados', de: '2026-09-01', ate: '2026-10-19' }).corpo)
    assert.equal(r.sla.entrega, 1)
    assert.equal(r.ciclos[0].etapas.entrega.situacao, 'fora_prazo')
})

// Erro do SDF no deploy: "The field help contained more than the maximum number ( 999 ) of characters".
test('objeto: help e description dos campos do script cabem no limite do SDF', () => {
    const xml = fs.readFileSync(path.join(__dirname, '..', 'src', 'Objects', 'customscript_glo_p2p_sla_sl.xml'), 'utf8')
    const texto = (tag) => [...xml.matchAll(new RegExp('<' + tag + '>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</' + tag + '>', 'g'))].map((m) => m[1])
    texto('help').forEach((h) => assert.ok(h.length <= 999, 'help com ' + h.length + ' caracteres'))
    texto('description').forEach((d) => assert.ok(d.length <= 999, 'description com ' + d.length + ' caracteres'))
})

// Sandbox sem o projeto P2P - Req: o registro de Bid nao existe e o painel segue sem as fases 4.2 e 4.3.
test('dados: sem o registro de Bid o painel funciona e avisa', () => {
    const { sl, consultas } = montarSuitelet('', /^bids$/)
    const r = JSON.parse(chamar(sl, { action: 'dados', de: '2026-09-01', ate: '2026-10-19' }).corpo)
    assert.equal(r.erro, undefined)
    assert.equal(r.ciclos[0].etapas.bid.situacao, 'sem_bid')
    assert.ok(r.avisos.some((a) => /Bid/.test(a)))
    assert.ok(!consultas.some((c) => c.nome === 'convidados'))
})

test('pagina: fases do manual, Bid e indicadores de conformidade aparecem', () => {
    const { sl } = montarSuitelet()
    const { corpo } = chamar(sl, {})
    assert.match(corpo, /Fase ' \+ esc\(e\.fase\)/)
    assert.match(corpo, /sem_bid/)
    assert.match(corpo, /custrecordentry\.nl\?rectype=/)
    assert.match(corpo, /reqMinimoCotacoes/)
    assert.match(corpo, /pagoAntesDoRecebimento/)
    ;['bid', 'propostas', 'negociacao'].forEach((id) => assert.match(corpo, new RegExp('COR_ETAPA = \\{[^}]*' + id + ':')))
})
