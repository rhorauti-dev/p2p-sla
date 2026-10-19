/**
 * GLO_P2P_SLA_SL.js
 *
 * Painel gerencial de SLA do procure-to-pay: Requisicao -> aprovacao ->
 * Pedido de compra -> aprovacao -> Recebimento -> Conta a pagar -> Pagamento,
 * por departamento, prioridade, aprovador, comprador e fornecedor.
 *
 *   GET                 pagina (HTML + Chart.js)
 *   GET action=dados    JSON: ciclos e agregados do periodo/filtros
 *
 * Fonte: SuiteQL somente leitura. A regra (marcos, etapas, SLA, agregados) fica
 * em GLO_P2P_SLA_Lib.js, testada em __tests__.
 *
 * Datas: abertura = createddate (o trandate pode ser retroativo); aprovacao =
 * systemnote TRANDOC.KSTATUS; recebimento e pagamento = trandate.
 *
 * Pagamento: so existe quando ha Bill Payment aplicado a conta a pagar. Conta
 * aberta com vencimento passado aparece como "sem baixa", nunca como paga.
 *
 * Orcamento de governanca (Suitelet = 1.000 unidades), action=dados:
 *   requisicoes 10 + notas da requisicao 10 + pedidos 10
 *   + por lote de ate 900 pedidos: notas 10, recebimentos 10, contas 10
 *   + por lote de ate 900 contas: pagamentos 10
 *   + 5 por pagina extra de 1.000 linhas. Um ano de dados (~700 ciclos) fica em ~80.
 *   Abaixo de GOVERNANCA_MINIMA a leitura para e a resposta volta com
 *   truncado = true, que a pagina mostra como aviso.
 *
 * Deployment roda como Administrador: o perfil do usuario pode nao ver
 * Requisicao. Quem acessa o painel e definido pelo publico do deployment.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/query', 'N/runtime', 'N/log', './GLO_P2P_SLA_Lib'], (query, runtime, log, lib) => {

    const GOVERNANCA_MINIMA = 60
    const LOTE = 900
    const F_HORA = "'YYYY-MM-DD\"T\"HH24:MI:SS'"
    const F_DIA = "'YYYY-MM-DD'"

    const SQL_REQS_ID = "SELECT t.id FROM transaction t WHERE t.type = 'PurchReq' " +
        "AND t.trandate BETWEEN TO_DATE(?, 'YYYY-MM-DD') AND TO_DATE(?, 'YYYY-MM-DD')"

    const SQL = {
        reqs: 'SELECT t.id, t.tranid, TO_CHAR(t.createddate, ' + F_HORA + ') criada, t.status, BUILTIN.DF(t.status) status_nome, ' +
            'BUILTIN.DF(t.entity) solicitante, t.custbody_prioridade prioridade_id, BUILTIN.DF(t.custbody_prioridade) prioridade, ' +
            'tl.department depto_id, BUILTIN.DF(tl.department) depto, tl.subsidiary sub_id, BUILTIN.DF(tl.subsidiary) subsidiaria, ' +
            'ABS(t.foreigntotal) total, t.memo ' +
            "FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' " +
            "WHERE t.type = 'PurchReq' AND t.trandate BETWEEN TO_DATE(?, 'YYYY-MM-DD') AND TO_DATE(?, 'YYYY-MM-DD')",
        reqNotas: 'SELECT s.recordid doc, TO_CHAR(s.date, ' + F_HORA + ') quando, BUILTIN.DF(s.name) quem, s.oldvalue de, s.newvalue para ' +
            "FROM systemnote s WHERE s.recordtypeid = -30 AND s.field = 'TRANDOC.KSTATUS' AND s.recordid IN (" + SQL_REQS_ID + ')',
        pos: 'SELECT DISTINCT l.previousdoc req_id, po.id, po.tranid, TO_CHAR(po.createddate, ' + F_HORA + ') criado, ' +
            'po.status, BUILTIN.DF(po.status) status_nome, BUILTIN.DF(po.entity) fornecedor, BUILTIN.DF(po.createdby) comprador, ' +
            'ABS(po.foreigntotal) total ' +
            "FROM previoustransactionlink l JOIN transaction po ON po.id = l.nextdoc AND po.type = 'PurchOrd' " +
            "WHERE l.linktype = 'POrdReq' AND l.previousdoc IN (" + SQL_REQS_ID + ')',
        poNotas: 'SELECT s.recordid doc, TO_CHAR(s.date, ' + F_HORA + ') quando, BUILTIN.DF(s.name) quem, s.oldvalue de, s.newvalue para ' +
            "FROM systemnote s WHERE s.recordtypeid = -30 AND s.field = 'TRANDOC.KSTATUS' AND s.recordid IN (#IDS#)",
        recebimentos: 'SELECT DISTINCT l.previousdoc po_id, r.id, r.tranid, TO_CHAR(r.trandate, ' + F_DIA + ') data ' +
            "FROM previoustransactionlink l JOIN transaction r ON r.id = l.nextdoc AND r.type = 'ItemRcpt' " +
            "WHERE l.linktype = 'ShipRcpt' AND l.previousdoc IN (#IDS#)",
        contas: 'SELECT DISTINCT l.previousdoc po_id, b.id, b.tranid, TO_CHAR(b.createddate, ' + F_HORA + ') criada, ' +
            'TO_CHAR(b.duedate, ' + F_DIA + ') vencimento, b.status, ABS(b.foreigntotal) total ' +
            "FROM previoustransactionlink l JOIN transaction b ON b.id = l.nextdoc AND b.type = 'VendBill' " +
            "WHERE l.linktype IN ('OrdBill', 'ShipRcpt') AND l.previousdoc IN (#IDS#)",
        pagamentos: 'SELECT DISTINCT l.previousdoc conta_id, p.id, p.tranid, TO_CHAR(p.trandate, ' + F_DIA + ') data ' +
            "FROM previoustransactionlink l JOIN transaction p ON p.id = l.nextdoc AND p.type = 'VendPymt' " +
            "WHERE l.linktype = 'Payment' AND l.previousdoc IN (#IDS#)"
    }

    function semGovernanca() {
        return runtime.getCurrentScript().getRemainingUsage() < GOVERNANCA_MINIMA
    }

    function ler(sql, params, estado) {
        if (estado.truncado || semGovernanca()) { estado.truncado = true; return [] }
        const linhas = []
        const paginado = query.runSuiteQLPaged({ query: sql, params: params || [], pageSize: 1000 })
        paginado.pageRanges.forEach((faixa) => {
            if (estado.truncado) return
            if (semGovernanca()) { estado.truncado = true; return }
            linhas.push.apply(linhas, paginado.fetch({ index: faixa.index }).data.asMappedResults())
        })
        return linhas
    }

    function lerEmLotes(sql, ids, estado) {
        const unicos = Array.from(new Set(ids.map(String))).filter((x) => /^\d+$/.test(x))
        const linhas = []
        for (let i = 0; i < unicos.length; i += LOTE) {
            linhas.push.apply(linhas, ler(sql.replace('#IDS#', unicos.slice(i, i + LOTE).join(',')), [], estado))
        }
        return linhas
    }

    function dataValida(texto) {
        return /^\d{4}-\d{2}-\d{2}$/.test(String(texto || ''))
    }

    function hojeIso() {
        const d = new Date()
        const p = (n) => String(n).padStart(2, '0')
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':00'
    }

    function opcoes(ciclos) {
        const unicos = (chaveId, chaveNome) => {
            const m = new Map()
            ciclos.forEach((c) => { if (c.req[chaveId] !== null && c.req[chaveId] !== undefined) m.set(String(c.req[chaveId]), c.req[chaveNome]) })
            return Array.from(m.entries()).map(([id, nome]) => ({ id, nome })).sort((a, b) => String(a.nome).localeCompare(String(b.nome)))
        }
        return { deptos: unicos('depto_id', 'depto'), subs: unicos('sub_id', 'subsidiaria'), prioridades: unicos('prioridade_id', 'prioridade') }
    }

    function dados(params) {
        const de = dataValida(params.de) ? params.de : null
        const ate = dataValida(params.ate) ? params.ate : null
        if (!de || !ate) return { erro: 'Informe o período (de / até) no formato AAAA-MM-DD.' }

        const config = lib.lerConfig(runtime.getCurrentScript().getParameter({ name: 'custscript_glo_p2p_sla_config_ip' }))
        const estado = { truncado: false }
        const periodo = [de, ate]

        const reqs = ler(SQL.reqs, periodo, estado)
        const reqNotas = ler(SQL.reqNotas, periodo, estado)
        const pos = ler(SQL.pos, periodo, estado)
        const poIds = pos.map((p) => p.id)
        const poNotas = lerEmLotes(SQL.poNotas, poIds, estado)
        const recebimentos = lerEmLotes(SQL.recebimentos, poIds, estado)
        const contas = lerEmLotes(SQL.contas, poIds, estado)
        const pagamentos = lerEmLotes(SQL.pagamentos, contas.map((c) => c.id), estado)

        const todos = lib.montarCiclos({ reqs, reqNotas, pos, poNotas, recebimentos, contas, pagamentos }, config, hojeIso())
        const ciclos = lib.filtrar(todos, { depto: params.depto, sub: params.sub, prioridade: params.prioridade, situacao: params.situacao })
        const avisos = []
        if (config.erro) avisos.push(config.erro + ' Usando o SLA padrão.')
        if (estado.truncado) avisos.push('Leitura interrompida por limite de governança: reduza o período. Os números abaixo estão incompletos.')
        const agregados = lib.agregar(ciclos)
        if (agregados.kpis.contasSemBaixa > 0) {
            avisos.push(agregados.kpis.contasSemBaixa + ' conta(s) a pagar vencida(s) sem pagamento registrado no NetSuite. ' +
                'A data de pagamento só existe quando o pagamento é lançado (Pagamento de fatura) contra a conta a pagar.')
        }
        log.audit('p2p-sla dados', { de, ate, ciclos: ciclos.length, governanca: runtime.getCurrentScript().getRemainingUsage() })
        return {
            periodo: { de, ate }, geradoEm: hojeIso(), truncado: estado.truncado, avisos,
            etapas: lib.ETAPAS, sla: config.etapas, slaConfig: { prioridade: config.prioridade, departamento: config.departamento, feriados: config.feriados },
            opcoes: opcoes(todos), agregados, ciclos
        }
    }

    const onRequest = (context) => {
        const params = context.request.parameters
        if (params.action === 'dados') {
            context.response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' })
            try {
                context.response.write(JSON.stringify(dados(params)))
            } catch (e) {
                log.error('p2p-sla dados', { name: e.name, message: e.message, stack: e.stack })
                context.response.write(JSON.stringify({ erro: e.name + ': ' + e.message }))
            }
            return
        }
        context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' })
        context.response.write(PAGE_HTML)
    }

    const PAGE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SLA Procure-to-Pay</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
:root{--bg:#f3f5f9;--card:#fff;--ink:#1d2433;--mute:#667085;--line:#e4e7ec;--brand:#1f4e79;--brand2:#2f80ed;
--ok:#12b76a;--okbg:#e8f8f0;--warn:#f79009;--warnbg:#fef4e6;--bad:#f04438;--badbg:#fdecea;--na:#98a2b3;--nabg:#f2f4f7}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 "Segoe UI",Roboto,Arial,sans-serif}
header{background:linear-gradient(120deg,#163a5f,#1f4e79 55%,#2f80ed);color:#fff;padding:18px 24px 14px}
header h1{margin:0;font-size:22px;font-weight:600;letter-spacing:.2px}
header p{margin:4px 0 0;opacity:.85;font-size:13px}
.filtros{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-top:14px}
.filtros label{display:flex;flex-direction:column;font-size:11px;text-transform:uppercase;letter-spacing:.4px;opacity:.9;gap:3px}
.filtros input,.filtros select{border:0;border-radius:6px;padding:7px 9px;font:inherit;color:var(--ink);min-width:130px}
button{border:0;border-radius:6px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
.bt-pri{background:#fff;color:var(--brand)}
.bt-sec{background:rgba(255,255,255,.16);color:#fff}
.bt-sec:hover{background:rgba(255,255,255,.26)}
main{padding:18px 24px 40px;max-width:1680px;margin:0 auto}
.avisos div{background:var(--warnbg);border-left:4px solid var(--warn);padding:9px 12px;border-radius:6px;margin-bottom:8px;font-size:13px}
.avisos div.erro{background:var(--badbg);border-color:var(--bad)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--card);border-radius:10px;padding:14px 16px;box-shadow:0 1px 2px rgba(16,24,40,.06);border-top:3px solid var(--brand2)}
.kpi .v{font-size:26px;font-weight:700;margin-top:4px}
.kpi .r{font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.4px}
.kpi .s{font-size:12px;color:var(--mute);margin-top:2px}
.kpi.ok{border-color:var(--ok)}.kpi.warn{border-color:var(--warn)}.kpi.bad{border-color:var(--bad)}
section{background:var(--card);border-radius:10px;box-shadow:0 1px 2px rgba(16,24,40,.06);padding:16px 18px;margin-bottom:16px}
section h2{margin:0 0 4px;font-size:16px}
section .sub{color:var(--mute);font-size:12.5px;margin:0 0 12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid2>section{margin-bottom:0}
.linha{margin-bottom:16px}
@media(max-width:1100px){.grid2{grid-template-columns:1fr}}
.fluxo{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}
@media(max-width:1300px){.fluxo{grid-template-columns:repeat(3,1fr)}}
@media(max-width:700px){.fluxo{grid-template-columns:1fr}}
.etapa{border:1px solid var(--line);border-radius:10px;padding:12px;position:relative;cursor:pointer;transition:box-shadow .15s}
.etapa:hover{box-shadow:0 4px 14px rgba(16,24,40,.1)}
.etapa.sel{outline:2px solid var(--brand2)}
.etapa .n{font-size:11px;color:var(--mute);font-weight:700}
.etapa h3{margin:2px 0 0;font-size:14px}
.etapa .resp{font-size:11.5px;color:var(--mute);margin-bottom:8px}
.etapa .big{font-size:24px;font-weight:700}
.etapa .big small{font-size:12px;color:var(--mute);font-weight:500}
.barra{height:8px;background:var(--badbg);border-radius:6px;overflow:hidden;margin:8px 0 4px}
.barra i{display:block;height:100%;background:var(--ok)}
.etapa .det{font-size:12px;color:var(--mute);display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap}
.tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11.5px;font-weight:600;white-space:nowrap}
.t-no_prazo,.t-concluido{background:var(--okbg);color:#067647}
.t-fora_prazo,.t-atrasada,.t-rejeitada,.t-rejeitado{background:var(--badbg);color:#b42318}
.t-andamento{background:var(--warnbg);color:#b54708}
.t-pendente,.t-nao_se_aplica,.t-encerrada,.t-encerrado{background:var(--nabg);color:#475467}
.canvas{position:relative;height:340px}
.canvas.alto{height:420px}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{background:#f8f9fb;text-align:left;font-weight:600;color:#344054;padding:8px;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1;white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:hover td{background:#fafbfc}
.num{text-align:right;font-variant-numeric:tabular-nums}
.heat td.c{text-align:center;font-weight:600;min-width:92px}
.heat td.c small{display:block;font-weight:400;font-size:11px;opacity:.8}
.rank{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
@media(max-width:1300px){.rank{grid-template-columns:1fr 1fr}}
@media(max-width:700px){.rank{grid-template-columns:1fr}}
.rank h3{font-size:13.5px;margin:0 0 6px}
.mini{height:6px;background:var(--line);border-radius:4px;overflow:hidden;min-width:60px}
.mini i{display:block;height:100%}
.tabela{overflow:auto;max-height:640px;border:1px solid var(--line);border-radius:8px}
.chips{display:flex;gap:3px}
.chip{min-width:34px;text-align:center;padding:2px 4px;border-radius:5px;font-size:11px;font-weight:600}
.ferramentas{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:10px}
.ferramentas input,.ferramentas select{border:1px solid var(--line);border-radius:6px;padding:6px 9px;font:inherit}
.pag{display:flex;gap:6px;align-items:center;justify-content:flex-end;margin-top:10px;font-size:12.5px;color:var(--mute)}
.pag button{background:var(--nabg);color:var(--ink);padding:5px 10px}
a{color:var(--brand2);text-decoration:none}
a:hover{text-decoration:underline}
.carregando{position:fixed;inset:0;background:rgba(243,245,249,.7);display:none;align-items:center;justify-content:center;z-index:50;font-weight:600;color:var(--brand)}
.carregando.on{display:flex}
.legenda{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--mute);margin-top:6px}
dialog{border:0;border-radius:12px;padding:20px 22px;max-width:720px;width:94%;box-shadow:0 20px 50px rgba(16,24,40,.25)}
dialog::backdrop{background:rgba(16,24,40,.35)}
pre{background:#f8f9fb;padding:10px;border-radius:6px;overflow:auto;font-size:12px}
</style>
</head>
<body>
<header>
  <h1>SLA Procure-to-Pay</h1>
  <p>Requisição &rarr; Aprovação &rarr; Pedido de compra &rarr; Aprovação &rarr; Recebimento &rarr; Lançamento da NF &rarr; Pagamento &middot; prazos em dias úteis</p>
  <div class="filtros">
    <label>De<input type="date" id="f-de"></label>
    <label>Até<input type="date" id="f-ate"></label>
    <label>Subsidiária<select id="f-sub"><option value="">Todas</option></select></label>
    <label>Departamento<select id="f-depto"><option value="">Todos</option></select></label>
    <label>Prioridade<select id="f-prioridade"><option value="">Todas</option></select></label>
    <label>Situação<select id="f-situacao"><option value="">Todas</option><option value="andamento">Em andamento</option><option value="concluido">Concluídos (pagos)</option><option value="rejeitado">Rejeitados</option><option value="encerrado">Encerrados</option></select></label>
    <button class="bt-pri" id="bt-atualizar">Atualizar</button>
    <button class="bt-sec" id="bt-xlsx">Exportar Excel</button>
    <button class="bt-sec" id="bt-pdf">Exportar PDF</button>
    <button class="bt-sec" id="bt-sla">Metas de SLA</button>
  </div>
</header>
<div class="carregando" id="carregando">Carregando dados do NetSuite…</div>
<main>
  <div class="avisos" id="avisos"></div>
  <div class="kpis" id="kpis"></div>

  <section class="linha">
    <h2>Fluxo do processo</h2>
    <p class="sub">Mediana de dias úteis por etapa, % concluído dentro do SLA e o que está parado agora. Clique numa etapa para filtrar a tabela de detalhe.</p>
    <div class="fluxo" id="fluxo"></div>
  </section>

  <div class="grid2 linha">
    <section>
      <h2>Tempo por etapa e departamento</h2>
      <p class="sub">Média de dias úteis em cada etapa concluída, empilhada por departamento solicitante.</p>
      <div class="canvas alto"><canvas id="g-deptos"></canvas></div>
    </section>
    <section>
      <h2>Onde estão os processos em andamento</h2>
      <p class="sub">Etapa atual de cada pedido em aberto, dentro e fora do SLA.</p>
      <div class="canvas alto"><canvas id="g-atual"></canvas></div>
    </section>
  </div>

  <section class="linha">
    <h2>Matriz de SLA departamental</h2>
    <p class="sub">% das etapas concluídas dentro do prazo (mediana de dias úteis abaixo). Verde &ge; 90%, amarelo &ge; 70%, vermelho &lt; 70%.</p>
    <div class="tabela" style="max-height:none"><table class="heat" id="heat"></table></div>
  </section>

  <div class="grid2 linha">
    <section>
      <h2>Evolução mensal</h2>
      <p class="sub">Mediana de dias úteis por etapa, pelo mês de abertura da requisição; barras = requisições abertas.</p>
      <div class="canvas"><canvas id="g-mensal"></canvas></div>
    </section>
    <section>
      <h2>Lead time total (requisição &rarr; pagamento)</h2>
      <p class="sub">Distribuição dos processos concluídos, em dias úteis.</p>
      <div class="canvas"><canvas id="g-hist"></canvas></div>
    </section>
  </div>

  <div class="grid2 linha">
    <section>
      <h2>Cumprimento do SLA por etapa</h2>
      <p class="sub">% no prazo e meta de cada etapa.</p>
      <div class="canvas"><canvas id="g-pct"></canvas></div>
    </section>
    <section>
      <h2>Dispersão por etapa</h2>
      <p class="sub">Mediana, média e P90 (90% dos casos ficam abaixo) em dias úteis, contra a meta.</p>
      <div class="canvas"><canvas id="g-disp"></canvas></div>
    </section>
  </div>

  <section class="linha">
    <h2>Desempenho por responsável</h2>
    <p class="sub">Quantidade de etapas concluídas, mediana de dias úteis e % no prazo. Aprovações automáticas não entram.</p>
    <div class="rank" id="rank"></div>
  </section>

  <section>
    <h2>Detalhe por requisição e pedido</h2>
    <p class="sub">Cada linha é um par requisição &times; pedido. Os chips mostram os dias úteis de cada etapa na cor da situação.</p>
    <div class="ferramentas">
      <input id="busca" placeholder="Buscar requisição, pedido, solicitante, fornecedor…" style="min-width:300px">
      <select id="f-etapa"><option value="">Todas as etapas</option></select>
      <select id="f-etapa-sit"><option value="">Qualquer situação</option><option value="atrasada">Atrasada agora</option><option value="fora_prazo">Concluída fora do prazo</option><option value="andamento">Em andamento no prazo</option><option value="no_prazo">Concluída no prazo</option></select>
      <span id="contagem" style="color:var(--mute);font-size:12.5px"></span>
    </div>
    <div class="legenda"><span class="tag t-no_prazo">no prazo</span><span class="tag t-fora_prazo">fora do prazo / atrasada</span><span class="tag t-andamento">em andamento</span><span class="tag t-pendente">pendente / não se aplica</span></div>
    <div class="tabela" style="margin-top:8px"><table id="detalhe"></table></div>
    <div class="pag" id="pag"></div>
  </section>
</main>

<dialog id="dlg-sla">
  <h2 style="margin-top:0">Metas de SLA (dias úteis)</h2>
  <div id="sla-corpo"></div>
  <p class="sub" style="margin-top:12px">As metas ficam no parâmetro <b>Configuração de SLA</b> do deployment do Suitelet, em JSON. A meta de departamento vence a de prioridade, que vence a geral. Exemplo:</p>
  <pre>{"etapas":{"aprovacao_req":2,"emissao_po":3,"aprovacao_po":2,"entrega":15,"lancamento":3,"pagamento":0},
 "prioridade":{"1":{"emissao_po":1,"aprovacao_req":1}},
 "departamento":{"38":{"entrega":10}},
 "feriados":["2026-11-02","2026-11-15","2026-11-20","2026-12-25"]}</pre>
  <div style="text-align:right"><button class="bt-pri" style="background:var(--brand);color:#fff" onclick="document.getElementById('dlg-sla').close()">Fechar</button></div>
</dialog>

<script>
(function () {
  'use strict';
  var CORES = ['#2f80ed', '#12b76a', '#f79009', '#7a5af8', '#ee46bc', '#06aed4', '#f04438', '#667085', '#15b79e', '#875bf7', '#fb6514', '#2e90fa', '#a15c07', '#4e5ba6'];
  var COR_ETAPA = { aprovacao_req: '#7a5af8', emissao_po: '#2f80ed', aprovacao_po: '#06aed4', entrega: '#f79009', lancamento: '#15b79e', pagamento: '#ee46bc' };
  var COR_SIT = { no_prazo: ['#e8f8f0', '#067647'], concluido: ['#e8f8f0', '#067647'], fora_prazo: ['#fdecea', '#b42318'], atrasada: ['#fdecea', '#b42318'], rejeitada: ['#fdecea', '#b42318'], andamento: ['#fef4e6', '#b54708'], pendente: ['#f2f4f7', '#98a2b3'], nao_se_aplica: ['#f2f4f7', '#98a2b3'], encerrada: ['#f2f4f7', '#98a2b3'] };
  var NOME_SIT = { no_prazo: 'No prazo', fora_prazo: 'Fora do prazo', atrasada: 'Atrasada', andamento: 'Em andamento', pendente: 'Pendente', nao_se_aplica: 'Não se aplica', encerrada: 'Encerrada', rejeitada: 'Rejeitada', concluido: 'Concluído', rejeitado: 'Rejeitado', encerrado: 'Encerrado' };
  var LINK = { req: '/app/accounting/transactions/purchreq.nl?id=', po: '/app/accounting/transactions/purchord.nl?id=', rec: '/app/accounting/transactions/itemrcpt.nl?id=', conta: '/app/accounting/transactions/vendbill.nl?id=', pag: '/app/accounting/transactions/vendpymt.nl?id=' };
  var POR_PAGINA = 50;
  var estado = { dados: null, graficos: {}, pagina: 1, etapaSel: '' };

  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  var moeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { return v == null ? '–' : nf.format(v); }
  function pct(v) { return v == null ? '–' : nf.format(v) + '%'; }
  function dataBr(iso) { if (!iso) return ''; var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function dataHoraBr(iso) { if (!iso) return ''; var h = String(iso).slice(11, 16); return dataBr(iso) + (h && h !== '00:00' ? ' ' + h : ''); }
  function isoLocal(d) { var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function link(tipo, id, texto) { return id ? '<a href="' + LINK[tipo] + id + '" target="_blank">' + esc(texto || id) + '</a>' : ''; }
  function tag(sit) { return '<span class="tag t-' + sit + '">' + esc(NOME_SIT[sit] || sit) + '</span>'; }
  function corPct(v) { if (v == null) return ['#f2f4f7', '#98a2b3']; if (v >= 90) return ['#d1fadf', '#05603a']; if (v >= 70) return ['#fef0c7', '#93370d']; return ['#fee4e2', '#912018']; }
  function nomeEtapa(id) { var e = (estado.dados.etapas || []).filter(function (x) { return x.id === id; })[0]; return e ? e.nome : id; }

  function lerFiltrosDaUrl() {
    var q = new URLSearchParams(location.search);
    var hoje = new Date();
    var ini = new Date(hoje.getFullYear(), hoje.getMonth() - 5, 1);
    $('f-de').value = q.get('de') || isoLocal(ini);
    $('f-ate').value = q.get('ate') || isoLocal(hoje);
  }

  function urlDados() {
    var q = new URLSearchParams(location.search);
    q.set('action', 'dados');
    ['de', 'ate', 'sub', 'depto', 'prioridade', 'situacao'].forEach(function (k) {
      var v = $('f-' + k).value;
      if (v) q.set(k, v); else q.delete(k);
    });
    return location.pathname + '?' + q.toString();
  }

  function carregar() {
    $('carregando').classList.add('on');
    fetch(urlDados(), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('carregando').classList.remove('on');
        if (d.erro) { $('avisos').innerHTML = '<div class="erro">' + esc(d.erro) + '</div>'; return; }
        estado.dados = d;
        estado.pagina = 1;
        preencherOpcoes(d.opcoes);
        render();
      })
      .catch(function (e) {
        $('carregando').classList.remove('on');
        $('avisos').innerHTML = '<div class="erro">Falha ao carregar: ' + esc(e.message) + '</div>';
      });
  }

  function preencherOpcoes(o) {
    [['f-sub', o.subs, 'Todas'], ['f-depto', o.deptos, 'Todos'], ['f-prioridade', o.prioridades, 'Todas']].forEach(function (x) {
      var sel = $(x[0]);
      var atual = sel.value;
      sel.innerHTML = '<option value="">' + x[2] + '</option>' + x[1].map(function (i) {
        return '<option value="' + esc(i.id) + '"' + (i.id === atual ? ' selected' : '') + '>' + esc(i.nome) + '</option>';
      }).join('');
    });
    var fe = $('f-etapa');
    if (fe.options.length <= 1) {
      fe.innerHTML = '<option value="">Todas as etapas</option>' + estado.dados.etapas.map(function (e) { return '<option value="' + e.id + '">' + esc(e.nome) + '</option>'; }).join('');
    }
  }

  function render() {
    var d = estado.dados;
    $('avisos').innerHTML = (d.avisos || []).map(function (a) { return '<div>' + esc(a) + '</div>'; }).join('');
    renderKpis(d);
    renderFluxo(d);
    renderDeptos(d);
    renderAtual(d);
    renderHeat(d);
    renderMensal(d);
    renderHist(d);
    renderPct(d);
    renderDisp(d);
    renderRank(d);
    renderDetalhe();
  }

  function kpi(rotulo, valor, sub, classe) {
    return '<div class="kpi ' + (classe || '') + '"><div class="r">' + rotulo + '</div><div class="v">' + valor + '</div><div class="s">' + (sub || '') + '</div></div>';
  }

  function renderKpis(d) {
    var k = d.agregados.kpis;
    var cls = k.pctEtapasNoPrazo == null ? '' : k.pctEtapasNoPrazo >= 90 ? 'ok' : k.pctEtapasNoPrazo >= 70 ? 'warn' : 'bad';
    $('kpis').innerHTML = [
      kpi('Requisições', num(k.requisicoes), k.ciclos + ' pares requisição × pedido'),
      kpi('Lead time (mediana)', num(k.leadMediana) + ' <small style="font-size:13px">d.u.</small>', 'média ' + num(k.leadMedia) + ' · P90 ' + num(k.leadP90) + ' · ' + k.concluidos + ' pagos'),
      kpi('Etapas no prazo', pct(k.pctEtapasNoPrazo), k.etapasConcluidas + ' etapas concluídas', cls),
      kpi('Atrasadas agora', num(k.atrasadasAgora), k.andamento + ' processos em andamento', k.atrasadasAgora ? 'bad' : 'ok'),
      kpi('Valor em pedidos', moeda.format(k.valorPedidos || 0), k.rejeitados + ' rejeitados · ' + k.encerrados + ' encerrados'),
      kpi('Contas a pagar', num(k.contas), k.contasPagas + ' com pagamento registrado · ' + k.contasSemBaixa + ' vencidas sem baixa', k.contasSemBaixa ? 'warn' : '')
    ].join('');
  }

  function renderFluxo(d) {
    $('fluxo').innerHTML = d.agregados.porEtapa.map(function (e, i) {
      var p = e.pctNoPrazo == null ? 0 : e.pctNoPrazo;
      var medida = e.id === 'pagamento'
        ? num(e.mediana) + ' <small>d.u. após venc.</small>'
        : num(e.mediana) + ' <small>d.u. (meta ' + num(d.sla[e.id]) + ')</small>';
      return '<div class="etapa' + (estado.etapaSel === e.id ? ' sel' : '') + '" data-etapa="' + e.id + '" style="border-top:4px solid ' + COR_ETAPA[e.id] + '">' +
        '<div class="n">ETAPA ' + (i + 1) + '</div><h3>' + esc(e.nome) + '</h3><div class="resp">' + esc(e.responsavel) + '</div>' +
        '<div class="big">' + medida + '</div>' +
        '<div class="barra"><i style="width:' + p + '%"></i></div>' +
        '<div class="det"><span><b>' + pct(e.pctNoPrazo) + '</b> no prazo (' + e.noPrazo + '/' + e.concluidas + ')</span></div>' +
        '<div class="det" style="margin-top:4px"><span>' + e.andamento + ' em andamento</span><span style="color:' + (e.atrasadas ? '#b42318' : 'inherit') + '"><b>' + e.atrasadas + '</b> atrasadas</span></div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.etapa'), function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-etapa');
        estado.etapaSel = estado.etapaSel === id ? '' : id;
        $('f-etapa').value = estado.etapaSel;
        if (estado.etapaSel && !$('f-etapa-sit').value) $('f-etapa-sit').value = 'atrasada';
        if (!estado.etapaSel) $('f-etapa-sit').value = '';
        estado.pagina = 1;
        renderFluxo(estado.dados);
        renderDetalhe();
        document.getElementById('detalhe').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function grafico(id, config) {
    if (estado.graficos[id]) estado.graficos[id].destroy();
    if (typeof Chart === 'undefined') return;
    estado.graficos[id] = new Chart($(id), config);
  }

  var BASE = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } };
  function opcoes(extra) { return Object.assign({}, BASE, extra || {}); }

  function renderDeptos(d) {
    var deptos = d.agregados.porDepto;
    grafico('g-deptos', {
      type: 'bar',
      data: {
        labels: deptos.map(function (x) { return x.depto; }),
        datasets: d.etapas.filter(function (e) { return e.id !== 'pagamento'; }).map(function (e) {
          return { label: e.nome, backgroundColor: COR_ETAPA[e.id], data: deptos.map(function (x) { return x.etapas[e.id].media || 0; }) };
        })
      },
      options: opcoes({ indexAxis: 'y', scales: { x: { stacked: true, title: { display: true, text: 'dias úteis (média)' } }, y: { stacked: true } },
        plugins: Object.assign({}, BASE.plugins, { tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + nf.format(c.raw) + ' d.u.'; } } } }) })
    });
  }

  function renderAtual(d) {
    var a = d.agregados.etapaAtual;
    grafico('g-atual', {
      type: 'bar',
      data: {
        labels: a.map(function (x) { return x.nome; }),
        datasets: [
          { label: 'No prazo', backgroundColor: '#fdb022', data: a.map(function (x) { return x.noPrazo; }) },
          { label: 'Atrasadas', backgroundColor: '#f04438', data: a.map(function (x) { return x.atrasadas; }) }
        ]
      },
      options: opcoes({ scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'processos' } } } })
    });
  }

  function renderHeat(d) {
    var etapas = d.etapas;
    var cab = '<thead><tr><th>Departamento</th><th class="num">Requisições</th><th class="num">Valor pedidos</th>' +
      etapas.map(function (e) { return '<th style="text-align:center">' + esc(e.nome) + '<br><small style="font-weight:400;color:#667085">' + esc(e.responsavel) + '</small></th>'; }).join('') +
      '<th class="num">Lead time<br><small style="font-weight:400">mediana</small></th><th class="num">Idade em aberto<br><small style="font-weight:400">mediana</small></th></tr></thead>';
    var linhas = d.agregados.porDepto.map(function (x) {
      return '<tr><td><b>' + esc(x.depto) + '</b></td><td class="num">' + x.requisicoes + '</td><td class="num">' + moeda.format(x.valor) + '</td>' +
        etapas.map(function (e) {
          var r = x.etapas[e.id];
          var c = corPct(r.pctNoPrazo);
          var extra = r.atrasadas ? ' · <b>' + r.atrasadas + ' atras.</b>' : '';
          return '<td class="c" style="background:' + c[0] + ';color:' + c[1] + '">' + pct(r.pctNoPrazo) +
            '<small>' + (r.concluidas ? num(r.mediana) + ' d.u. · ' + r.concluidas + ' conc.' : 'sem conclusão') + extra + '</small></td>';
        }).join('') +
        '<td class="num">' + num(x.leadMediana) + '</td><td class="num">' + num(x.idadeMediana) + '</td></tr>';
    }).join('');
    $('heat').innerHTML = cab + '<tbody>' + linhas + '</tbody>';
  }

  function nomeMes(m) { var p = m.split('-'); return ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(p[1]) - 1] + '/' + p[0].slice(2); }

  function renderMensal(d) {
    var m = d.agregados.mensal;
    var ds = d.etapas.filter(function (e) { return e.id !== 'pagamento'; }).map(function (e) {
      return { type: 'line', label: e.nome, borderColor: COR_ETAPA[e.id], backgroundColor: COR_ETAPA[e.id], tension: .3, spanGaps: true, yAxisID: 'y',
        data: m.map(function (x) { return x.etapas[e.id].mediana; }) };
    });
    ds.push({ type: 'bar', label: 'Requisições', backgroundColor: 'rgba(152,162,179,.25)', yAxisID: 'y2', data: m.map(function (x) { return x.requisicoes; }) });
    grafico('g-mensal', {
      data: { labels: m.map(function (x) { return nomeMes(x.mes); }), datasets: ds },
      options: opcoes({ scales: { y: { beginAtZero: true, title: { display: true, text: 'dias úteis (mediana)' } }, y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { precision: 0 } } } })
    });
  }

  function renderHist(d) {
    var h = d.agregados.histograma;
    grafico('g-hist', {
      type: 'bar',
      data: { labels: h.map(function (x) { return x.faixa + ' d.u.'; }), datasets: [{ label: 'Processos pagos', backgroundColor: '#2f80ed', borderRadius: 4, data: h.map(function (x) { return x.qtd; }) }] },
      options: opcoes({ plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } })
    });
  }

  function renderPct(d) {
    var e = d.agregados.porEtapa;
    grafico('g-pct', {
      type: 'bar',
      data: {
        labels: e.map(function (x) { return x.nome; }),
        datasets: [{ label: '% no prazo', borderRadius: 4, data: e.map(function (x) { return x.pctNoPrazo; }),
          backgroundColor: e.map(function (x) { return x.pctNoPrazo == null ? '#d0d5dd' : x.pctNoPrazo >= 90 ? '#12b76a' : x.pctNoPrazo >= 70 ? '#f79009' : '#f04438'; }) }]
      },
      options: opcoes({ plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { var x = e[c.dataIndex]; return pct(x.pctNoPrazo) + ' (' + x.noPrazo + '/' + x.concluidas + ')'; } } } },
        scales: { y: { min: 0, max: 100, ticks: { callback: function (v) { return v + '%'; } } } } })
    });
  }

  function renderDisp(d) {
    var e = d.agregados.porEtapa.filter(function (x) { return x.id !== 'pagamento'; });
    grafico('g-disp', {
      type: 'bar',
      data: {
        labels: e.map(function (x) { return x.nome; }),
        datasets: [
          { label: 'Mediana', backgroundColor: '#2f80ed', data: e.map(function (x) { return x.mediana; }) },
          { label: 'Média', backgroundColor: '#7a5af8', data: e.map(function (x) { return x.media; }) },
          { label: 'P90', backgroundColor: '#f79009', data: e.map(function (x) { return x.p90; }) },
          { type: 'line', label: 'Meta (SLA)', borderColor: '#f04438', backgroundColor: '#f04438', borderDash: [6, 4], pointRadius: 4, data: e.map(function (x) { return d.sla[x.id]; }) }
        ]
      },
      options: opcoes({ scales: { y: { beginAtZero: true, title: { display: true, text: 'dias úteis' } } } })
    });
  }

  function tabelaRank(titulo, lista) {
    var max = Math.max.apply(null, lista.map(function (x) { return x.mediana || 0; }).concat([1]));
    return '<div><h3>' + titulo + '</h3><table><thead><tr><th>Nome</th><th class="num">Qtd</th><th class="num">Mediana</th><th class="num">No prazo</th><th></th></tr></thead><tbody>' +
      (lista.length ? lista.slice(0, 12).map(function (x) {
        var c = corPct(x.pctNoPrazo);
        return '<tr><td>' + esc(x.nome) + '</td><td class="num">' + x.n + '</td><td class="num">' + num(x.mediana) + '</td>' +
          '<td class="num"><span class="tag" style="background:' + c[0] + ';color:' + c[1] + '">' + pct(x.pctNoPrazo) + '</span></td>' +
          '<td><div class="mini"><i style="width:' + Math.round(((x.mediana || 0) / max) * 100) + '%;background:' + c[1] + '"></i></div></td></tr>';
      }).join('') : '<tr><td colspan="5" style="color:#98a2b3">Sem etapas concluídas</td></tr>') +
      '</tbody></table></div>';
  }

  function renderRank(d) {
    var r = d.agregados.rankings;
    $('rank').innerHTML = tabelaRank('Aprovadores de requisição', r.aprovadoresReq) + tabelaRank('Compradores (emissão do pedido)', r.compradores) +
      tabelaRank('Aprovadores de pedido', r.aprovadoresPo) + tabelaRank('Fornecedores (prazo de entrega)', r.fornecedores);
  }

  function ciclosVisiveis() {
    var termo = $('busca').value.trim().toLowerCase();
    var etapa = $('f-etapa').value;
    var sit = $('f-etapa-sit').value;
    return estado.dados.ciclos.filter(function (c) {
      if (etapa && sit && c.etapas[etapa].situacao !== sit) return false;
      if (etapa && !sit && ['pendente', 'nao_se_aplica'].indexOf(c.etapas[etapa].situacao) >= 0) return false;
      if (!etapa && sit && !Object.keys(c.etapas).some(function (k) { return c.etapas[k].situacao === sit; })) return false;
      if (!termo) return true;
      var alvo = [c.req.tranid, c.req.solicitante, c.req.depto, c.req.memo, c.po && c.po.tranid, c.po && c.po.fornecedor, c.po && c.po.comprador].join(' ').toLowerCase();
      return alvo.indexOf(termo) >= 0;
    });
  }

  function chip(e, id) {
    var c = COR_SIT[e.situacao] || COR_SIT.pendente;
    var valor = e.situacao === 'pendente' || e.situacao === 'nao_se_aplica' || e.situacao === 'encerrada' ? '·' : (id === 'pagamento' && e.atrasoMaximo != null ? (e.atrasoMaximo > 0 ? '+' : '') + nf.format(e.atrasoMaximo) : nf.format(e.dias || 0));
    var dica = nomeEtapa(id) + ': ' + (NOME_SIT[e.situacao] || e.situacao) + (e.dias != null ? ' · ' + nf.format(e.dias) + ' d.u.' : '') + ' · meta ' + e.sla + (e.automatica ? ' · aprovação automática' : '') + (e.quem ? ' · ' + e.quem : '');
    return '<span class="chip" title="' + esc(dica) + '" style="background:' + c[0] + ';color:' + c[1] + '">' + valor + '</span>';
  }

  function renderDetalhe() {
    if (!estado.dados) return;
    var lista = ciclosVisiveis();
    var paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    if (estado.pagina > paginas) estado.pagina = paginas;
    var pagina = lista.slice((estado.pagina - 1) * POR_PAGINA, estado.pagina * POR_PAGINA);
    $('contagem').textContent = lista.length + ' de ' + estado.dados.ciclos.length + ' linhas';
    var cab = '<thead><tr><th>Requisição</th><th>Departamento</th><th>Solicitante</th><th>Prioridade</th><th>Abertura req.</th><th>Aprovação req.</th>' +
      '<th>Pedido</th><th>Abertura PO</th><th>Aprovação PO</th><th>Fornecedor</th><th>Recebimento</th><th>NF lançada</th><th>Vencimento</th><th>Pagamento</th>' +
      '<th title="Aprov. req · Emissão PO · Aprov. PO · Entrega · Lançamento · Pagamento (dias após o vencimento)">Dias úteis por etapa</th><th class="num">Lead time</th><th class="num">Valor PO</th><th>Situação</th></tr></thead>';
    var corpo = pagina.map(function (c) {
      var m = c.marcos;
      var contas = c.contas || [];
      var pagos = [];
      contas.forEach(function (x) { (x.pagamentos || []).forEach(function (p) { pagos.push(link('pag', p.id, dataBr(p.data))); }); });
      return '<tr>' +
        '<td>' + link('req', c.req.id, '#' + c.req.tranid) + '</td>' +
        '<td>' + esc(c.req.depto) + '</td><td>' + esc(c.req.solicitante) + '</td><td>' + esc(c.req.prioridade) + '</td>' +
        '<td>' + dataHoraBr(m.req_criada) + '</td>' +
        '<td>' + (c.etapas.aprovacao_req.automatica ? '<span style="color:#98a2b3">automática</span>' : dataHoraBr(m.req_aprovada)) + '</td>' +
        '<td>' + (c.po ? link('po', c.po.id, c.po.tranid) : '') + '</td>' +
        '<td>' + dataHoraBr(m.po_criado) + '</td>' +
        '<td>' + (c.etapas.aprovacao_po.automatica ? '<span style="color:#98a2b3">automática</span>' : dataHoraBr(m.po_aprovado)) + '</td>' +
        '<td>' + esc(c.po ? c.po.fornecedor : '') + '</td>' +
        '<td>' + (c.servico ? '<span style="color:#98a2b3">serviço</span>' : (c.recebimentos || []).slice(0, 1).map(function (r) { return link('rec', r.id, dataBr(r.data)); }).join('')) + '</td>' +
        '<td>' + contas.slice(0, 2).map(function (x) { return link('conta', x.id, dataHoraBr(x.criada)); }).join('<br>') + '</td>' +
        '<td>' + contas.slice(0, 2).map(function (x) { return dataBr(x.vencimento); }).join('<br>') + '</td>' +
        '<td>' + (pagos.length ? pagos.slice(0, 2).join('<br>') : (contas.length ? '<span style="color:#b42318">sem baixa</span>' : '')) + '</td>' +
        '<td><div class="chips">' + estado.dados.etapas.map(function (e) { return chip(c.etapas[e.id], e.id); }).join('') + '</div></td>' +
        '<td class="num">' + (c.leadUteis != null ? num(c.leadUteis) : '<span style="color:#98a2b3">' + num(c.idadeUteis) + '</span>') + '</td>' +
        '<td class="num">' + (c.po ? moeda.format(c.po.total) : '') + '</td>' +
        '<td>' + tag(c.situacao) + (c.etapaAtual ? '<br><small style="color:#667085">' + esc(nomeEtapa(c.etapaAtual)) + '</small>' : '') + '</td>' +
        '</tr>';
    }).join('');
    $('detalhe').innerHTML = cab + '<tbody>' + (corpo || '<tr><td colspan="18" style="color:#98a2b3;padding:18px">Nenhuma linha com esses filtros.</td></tr>') + '</tbody>';
    $('pag').innerHTML = '<button id="pg-ant"' + (estado.pagina <= 1 ? ' disabled' : '') + '>&lsaquo; Anterior</button><span>Página ' + estado.pagina + ' de ' + paginas + '</span><button id="pg-prox"' + (estado.pagina >= paginas ? ' disabled' : '') + '>Próxima &rsaquo;</button>';
    $('pg-ant').onclick = function () { estado.pagina--; renderDetalhe(); };
    $('pg-prox').onclick = function () { estado.pagina++; renderDetalhe(); };
  }

  // Bibliotecas de exportacao: carregadas so no primeiro clique.
  var LIBS = {
    xlsx: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'],
    pdf: ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js']
  };
  var carregadas = {};

  function carregarScript(src) {
    if (carregadas[src]) return carregadas[src];
    carregadas[src] = new Promise(function (ok, falha) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = function () { delete carregadas[src]; falha(new Error('não foi possível carregar ' + src)); };
      document.head.appendChild(s);
    });
    return carregadas[src];
  }

  function carregarLibs(tipo) {
    return LIBS[tipo].reduce(function (p, src) { return p.then(function () { return carregarScript(src); }); }, Promise.resolve());
  }

  function exportar(tipo, gerar) {
    if (!estado.dados) return;
    $('carregando').textContent = 'Gerando ' + (tipo === 'pdf' ? 'PDF' : 'Excel') + '…';
    $('carregando').classList.add('on');
    carregarLibs(tipo).then(gerar).catch(function (e) {
      $('avisos').insertAdjacentHTML('afterbegin', '<div class="erro">Falha ao exportar: ' + esc(e.message) + '</div>');
    }).then(function () {
      $('carregando').classList.remove('on');
      $('carregando').textContent = 'Carregando dados do NetSuite…';
    });
  }

  function nomeArquivo(ext) { return 'sla-p2p-' + $('f-de').value + '-a-' + $('f-ate').value + '.' + ext; }

  function textoFiltros() {
    var partes = ['Período: ' + dataBr($('f-de').value) + ' a ' + dataBr($('f-ate').value)];
    ['sub', 'depto', 'prioridade', 'situacao'].forEach(function (k) {
      var sel = $('f-' + k);
      if (sel.value) partes.push(sel.parentNode.firstChild.textContent.trim() + ': ' + sel.options[sel.selectedIndex].text);
    });
    return partes.join(' · ');
  }

  // Linhas do detalhe (respeitam busca e filtro de etapa da tabela). Numeros ficam numero.
  function linhasDetalhe() {
    var etapas = estado.dados.etapas;
    var cab = ['Requisição', 'Departamento', 'Solicitante', 'Prioridade', 'Subsidiária', 'Abertura requisição', 'Aprovação requisição', 'Aprovador requisição',
      'Pedido', 'Abertura pedido', 'Aprovação pedido', 'Aprovador pedido', 'Comprador', 'Fornecedor', 'Recebimento', 'NF lançada', 'Vencimento', 'Pagamento',
      'Valor pedido', 'Situação', 'Etapa atual', 'Lead time (d.u.)'];
    etapas.forEach(function (e) { cab.push(e.nome + (e.id === 'pagamento' ? ' (d.u. após venc.)' : ' (d.u.)'), e.nome + ' – situação', e.nome + ' – meta'); });
    var linhas = ciclosVisiveis().map(function (c) {
      var m = c.marcos;
      var contas = c.contas || [];
      var pagos = [];
      contas.forEach(function (x) { (x.pagamentos || []).forEach(function (p) { pagos.push(dataBr(p.data)); }); });
      var aprovReq = c.etapas.aprovacao_req.automatica ? 'automática' : dataHoraBr(m.req_aprovada);
      var aprovPo = c.etapas.aprovacao_po.automatica ? 'automática' : dataHoraBr(m.po_aprovado);
      var l = ['#' + c.req.tranid, c.req.depto, c.req.solicitante || '', c.req.prioridade, c.req.subsidiaria || '', dataHoraBr(m.req_criada), aprovReq, c.etapas.aprovacao_req.quem || '',
        c.po ? c.po.tranid : '', dataHoraBr(m.po_criado), aprovPo, c.etapas.aprovacao_po.quem || '', c.po ? c.po.comprador || '' : '', c.po ? c.po.fornecedor || '' : '',
        c.servico ? 'serviço' : (c.recebimentos[0] ? dataBr(c.recebimentos[0].data) : ''), contas.map(function (x) { return dataHoraBr(x.criada); }).join(' | '),
        contas.map(function (x) { return dataBr(x.vencimento); }).join(' | '), pagos.length ? pagos.join(' | ') : (contas.length ? 'sem baixa' : ''),
        c.po ? c.po.total : null, NOME_SIT[c.situacao] || c.situacao, c.etapaAtual ? nomeEtapa(c.etapaAtual) : '', c.leadUteis];
      etapas.forEach(function (e) {
        var x = c.etapas[e.id];
        var v = e.id === 'pagamento' ? x.atrasoMaximo : x.dias;
        l.push(v == null ? null : v, NOME_SIT[x.situacao] || x.situacao, x.sla);
      });
      return l;
    });
    return { cab: cab, linhas: linhas };
  }

  function tabelaEtapas() {
    var d = estado.dados;
    return {
      cab: ['Etapa', 'Responsável', 'Meta (d.u.)', 'Mediana', 'Média', 'P90', '% no prazo', 'No prazo', 'Concluídas', 'Em andamento', 'Atrasadas'],
      linhas: d.agregados.porEtapa.map(function (e) {
        return [e.nome, e.responsavel, e.id === 'pagamento' ? 'venc. + ' + d.sla[e.id] : d.sla[e.id], e.mediana, e.media, e.p90, e.pctNoPrazo, e.noPrazo, e.concluidas, e.andamento, e.atrasadas];
      })
    };
  }

  function tabelaKpis() {
    var k = estado.dados.agregados.kpis;
    return [
      ['Requisições', k.requisicoes], ['Pares requisição × pedido', k.ciclos], ['Processos pagos (concluídos)', k.concluidos],
      ['Em andamento', k.andamento], ['Rejeitados', k.rejeitados], ['Encerrados sem conclusão', k.encerrados],
      ['Lead time requisição → pagamento – mediana (d.u.)', k.leadMediana], ['Lead time – média (d.u.)', k.leadMedia], ['Lead time – P90 (d.u.)', k.leadP90],
      ['% de etapas concluídas no prazo', k.pctEtapasNoPrazo], ['Etapas concluídas', k.etapasConcluidas], ['Etapas atrasadas agora', k.atrasadasAgora],
      ['Valor em pedidos (R$)', k.valorPedidos], ['Contas a pagar', k.contas], ['Contas com pagamento registrado', k.contasPagas], ['Contas vencidas sem baixa', k.contasSemBaixa]
    ];
  }

  function exportarExcel() {
    var d = estado.dados;
    var XLSX = window.XLSX;
    var wb = XLSX.utils.book_new();
    var folha = function (nome, linhas, larguras) {
      var ws = XLSX.utils.aoa_to_sheet(linhas);
      if (larguras) ws['!cols'] = larguras.map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, ws, nome);
      return ws;
    };

    folha('Resumo', [['SLA Procure-to-Pay'], [textoFiltros()], ['Gerado em ' + dataHoraBr(d.geradoEm)], []]
      .concat([['Indicador', 'Valor']]).concat(tabelaKpis())
      .concat([[], ['Avisos']]).concat((d.avisos || []).map(function (a) { return [a]; })), [52, 22]);

    var et = tabelaEtapas();
    folha('Etapas', [et.cab].concat(et.linhas), [26, 24, 11, 9, 9, 9, 11, 9, 11, 13, 10]);

    var cabD = ['Departamento', 'Requisições', 'Pares', 'Valor pedidos', 'Lead time mediana', 'Idade em aberto mediana'];
    d.etapas.forEach(function (e) { cabD.push(e.nome + ' – % no prazo', e.nome + ' – mediana', e.nome + ' – concluídas', e.nome + ' – atrasadas'); });
    folha('Departamentos', [cabD].concat(d.agregados.porDepto.map(function (x) {
      var l = [x.depto, x.requisicoes, x.ciclos, x.valor, x.leadMediana, x.idadeMediana];
      d.etapas.forEach(function (e) { var r = x.etapas[e.id]; l.push(r.pctNoPrazo, r.mediana, r.concluidas, r.atrasadas); });
      return l;
    })), [28, 11, 8, 14, 12, 14]);

    var cabM = ['Mês', 'Requisições', 'Lead time mediana'];
    d.etapas.forEach(function (e) { cabM.push(e.nome + ' – mediana', e.nome + ' – % no prazo'); });
    folha('Mensal', [cabM].concat(d.agregados.mensal.map(function (x) {
      var l = [nomeMes(x.mes), x.requisicoes, x.leadMediana];
      d.etapas.forEach(function (e) { l.push(x.etapas[e.id].mediana, x.etapas[e.id].pctNoPrazo); });
      return l;
    })), [10, 11, 12]);

    var r = d.agregados.rankings;
    var rank = [];
    [['Aprovadores de requisição', r.aprovadoresReq], ['Compradores (emissão do pedido)', r.compradores],
      ['Aprovadores de pedido', r.aprovadoresPo], ['Fornecedores (prazo de entrega)', r.fornecedores]].forEach(function (g) {
      rank.push([g[0]], ['Nome', 'Qtd', 'Mediana (d.u.)', 'Média (d.u.)', '% no prazo']);
      g[1].forEach(function (x) { rank.push([x.nome, x.n, x.mediana, x.media, x.pctNoPrazo]); });
      rank.push([]);
    });
    folha('Responsáveis', rank, [40, 8, 14, 12, 11]);

    var det = linhasDetalhe();
    var ws = folha('Detalhe', [det.cab].concat(det.linhas), det.cab.map(function (c, i) { return i < 2 ? 12 : Math.min(Math.max(c.length, 11), 26); }));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: det.linhas.length, c: det.cab.length - 1 } }) };

    XLSX.writeFile(wb, nomeArquivo('xlsx'));
  }

  function imagemGrafico(id) {
    var g = estado.graficos[id];
    if (!g) return null;
    var c = g.canvas;
    var tmp = document.createElement('canvas');
    tmp.width = c.width;
    tmp.height = c.height;
    var ctx = tmp.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(c, 0, 0);
    // JPEG: o PNG do canvas em alta densidade deixava o PDF com ~7 MB.
    return { url: tmp.toDataURL('image/jpeg', 0.9), proporcao: c.height / c.width };
  }

  function rgb(hex) { var h = hex.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

  function exportarPdf() {
    var d = estado.dados;
    var JsPdf = window.jspdf.jsPDF;
    var doc = new JsPdf({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    var L = doc.internal.pageSize.getWidth();
    var A = doc.internal.pageSize.getHeight();
    var M = 10;
    var AZUL = rgb('#1f4e79');
    var fmt = function (v, sufixo) { return v == null ? '–' : nf.format(v) + (sufixo || ''); };

    function cabecalho(titulo) {
      doc.setFillColor(AZUL[0], AZUL[1], AZUL[2]);
      doc.rect(0, 0, L, 16, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(13);
      doc.text('SLA Procure-to-Pay' + (titulo ? ' · ' + titulo : ''), M, 10);
      doc.setFontSize(8);
      doc.text(textoFiltros(), L - M, 7, { align: 'right' });
      doc.text('Gerado em ' + dataHoraBr(d.geradoEm), L - M, 12, { align: 'right' });
      doc.setTextColor(29, 36, 51);
    }
    function novaPagina(titulo) { doc.addPage(); cabecalho(titulo); return 22; }
    function tituloSecao(texto, y, x) { doc.setFontSize(11); doc.setTextColor(AZUL[0], AZUL[1], AZUL[2]); doc.text(texto, x || M, y); doc.setTextColor(29, 36, 51); return y + 3; }
    function graficoEm(id, x, y, largura, alturaMax) {
      var img = imagemGrafico(id);
      if (!img) return y;
      var h = Math.min(largura * img.proporcao, alturaMax);
      var w = h / img.proporcao;
      doc.addImage(img.url, 'JPEG', x, y, w, h);
      return y + h;
    }
    var estilo = { fontSize: 8, cellPadding: 1.6, lineColor: [228, 231, 236], lineWidth: 0.1 };
    var cabEstilo = { fillColor: AZUL, textColor: 255, fontStyle: 'bold' };

    // Pagina 1: indicadores + etapas + graficos de cumprimento.
    cabecalho('Resumo');
    var k = d.agregados.kpis;
    var cartoes = [
      ['Requisições', fmt(k.requisicoes), k.ciclos + ' pares req. × pedido'],
      ['Lead time (mediana)', fmt(k.leadMediana, ' d.u.'), 'média ' + fmt(k.leadMedia) + ' · P90 ' + fmt(k.leadP90)],
      ['Etapas no prazo', fmt(k.pctEtapasNoPrazo, '%'), k.etapasConcluidas + ' concluídas'],
      ['Atrasadas agora', fmt(k.atrasadasAgora), k.andamento + ' em andamento'],
      ['Valor em pedidos', moeda.format(k.valorPedidos || 0), k.rejeitados + ' rejeitados'],
      ['Contas a pagar', fmt(k.contas), k.contasSemBaixa + ' vencidas sem baixa']
    ];
    var wc = (L - 2 * M - 5 * 4) / 6;
    cartoes.forEach(function (c, i) {
      var x = M + i * (wc + 4);
      doc.setFillColor(248, 249, 251);
      doc.roundedRect(x, 20, wc, 22, 2, 2, 'F');
      doc.setFillColor(47, 128, 237);
      doc.rect(x, 20, wc, 1.2, 'F');
      doc.setFontSize(7.5); doc.setTextColor(102, 112, 133); doc.text(c[0].toUpperCase(), x + 3, 26);
      doc.setFontSize(14); doc.setTextColor(29, 36, 51); doc.text(String(c[1]), x + 3, 34);
      doc.setFontSize(7); doc.setTextColor(102, 112, 133); doc.text(c[2], x + 3, 39);
    });
    doc.setTextColor(29, 36, 51);
    var y = tituloSecao('Etapas do processo', 50);
    var et = tabelaEtapas();
    doc.autoTable({
      startY: y, margin: { left: M, right: M }, head: [et.cab],
      body: et.linhas.map(function (l) { return l.map(function (v, i) { return i === 6 ? fmt(v, '%') : (typeof v === 'number' ? fmt(v) : (v == null ? '–' : v)); }); }),
      styles: estilo, headStyles: cabEstilo,
      didParseCell: function (h) {
        if (h.section === 'body' && h.column.index === 6) {
          var c = corPct(et.linhas[h.row.index][6]);
          h.cell.styles.fillColor = rgb(c[0]); h.cell.styles.textColor = rgb(c[1]); h.cell.styles.fontStyle = 'bold';
        }
      }
    });
    y = doc.lastAutoTable.finalY + 6;
    var meia = (L - 2 * M - 8) / 2;
    var alturaRestante = A - y - 8;
    tituloSecao('Cumprimento do SLA por etapa', y);
    tituloSecao('Dispersão por etapa', y, M + meia + 8);
    graficoEm('g-pct', M, y + 3, meia, alturaRestante);
    graficoEm('g-disp', M + meia + 8, y + 3, meia, alturaRestante);

    // Pagina 2: departamentos.
    y = novaPagina('Departamentos');
    y = tituloSecao('Matriz de SLA departamental (% no prazo · mediana em d.u.)', y);
    var cabH = ['Departamento', 'Req.', 'Valor pedidos'].concat(d.etapas.map(function (e) { return e.nome; })).concat(['Lead time', 'Idade aberto']);
    var corpoH = d.agregados.porDepto.map(function (x) {
      return [x.depto, x.requisicoes, moeda.format(x.valor)].concat(d.etapas.map(function (e) {
        var r = x.etapas[e.id];
        return r.concluidas ? fmt(r.pctNoPrazo, '%') + '\\n' + fmt(r.mediana) + ' d.u.' + (r.atrasadas ? ' · ' + r.atrasadas + ' atras.' : '') : (r.atrasadas ? r.atrasadas + ' atras.' : '–');
      })).concat([fmt(x.leadMediana), fmt(x.idadeMediana)]);
    });
    doc.autoTable({
      startY: y, margin: { left: M, right: M }, head: [cabH], body: corpoH,
      styles: Object.assign({}, estilo, { fontSize: 7.5, valign: 'middle' }), headStyles: cabEstilo,
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 34 } },
      didParseCell: function (h) {
        var i = h.column.index - 3;
        if (h.section === 'body' && i >= 0 && i < d.etapas.length) {
          var r = d.agregados.porDepto[h.row.index].etapas[d.etapas[i].id];
          var c = corPct(r.pctNoPrazo);
          h.cell.styles.fillColor = rgb(c[0]); h.cell.styles.textColor = rgb(c[1]); h.cell.styles.halign = 'center';
        }
      }
    });
    y = doc.lastAutoTable.finalY + 6;
    if (A - y < 70) y = novaPagina('Departamentos');
    tituloSecao('Tempo por etapa e departamento', y);
    tituloSecao('Onde estão os processos em andamento', y, M + meia + 8);
    graficoEm('g-deptos', M, y + 3, meia, A - y - 10);
    graficoEm('g-atual', M + meia + 8, y + 3, meia, A - y - 10);

    // Pagina 3: evolucao e distribuicao.
    y = novaPagina('Evolução');
    tituloSecao('Evolução mensal (mediana em d.u.)', y);
    tituloSecao('Lead time total – processos pagos', y, M + meia + 8);
    graficoEm('g-mensal', M, y + 3, meia, 95);
    graficoEm('g-hist', M + meia + 8, y + 3, meia, 95);

    // Pagina 4: responsaveis.
    y = novaPagina('Responsáveis');
    var r = d.agregados.rankings;
    var grupos = [['Aprovadores de requisição', r.aprovadoresReq], ['Compradores (emissão do pedido)', r.compradores],
      ['Aprovadores de pedido', r.aprovadoresPo], ['Fornecedores (prazo de entrega)', r.fornecedores]];
    var fimLinha1 = y;
    grupos.forEach(function (g, i) {
      var x = M + (i % 2) * (meia + 8);
      var yi = i < 2 ? y : fimLinha1 + 8;
      tituloSecao(g[0], yi, x);
      doc.autoTable({
        startY: yi + 2, margin: { left: x }, tableWidth: meia,
        head: [['Nome', 'Qtd', 'Mediana', 'Média', '% no prazo']],
        body: g[1].slice(0, 15).map(function (z) { return [z.nome, z.n, fmt(z.mediana), fmt(z.media), fmt(z.pctNoPrazo, '%')]; }),
        styles: estilo, headStyles: cabEstilo, columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
        didParseCell: function (h) {
          if (h.section === 'body' && h.column.index === 4) {
            var c = corPct(g[1][h.row.index].pctNoPrazo);
            h.cell.styles.fillColor = rgb(c[0]); h.cell.styles.textColor = rgb(c[1]);
          }
        }
      });
      if (i < 2) fimLinha1 = Math.max(fimLinha1, doc.lastAutoTable.finalY);
    });

    // Detalhe.
    y = novaPagina('Detalhe');
    var det = linhasDetalhe();
    var COLS = [0, 1, 2, 5, 6, 8, 9, 10, 13, 14, 15, 16, 17, 21, 19, 20];
    var ETQ = ['Req.', 'Depto', 'Solicitante', 'Abertura req.', 'Aprov. req.', 'PO', 'Abertura PO', 'Aprov. PO', 'Fornecedor', 'Receb.', 'NF lançada', 'Venc.', 'Pagamento', 'Lead d.u.', 'Situação', 'Etapa atual'];
    var cores = { 'Concluído': '#e8f8f0', 'Em andamento': '#fef4e6', 'Rejeitado': '#fdecea', 'Encerrado': '#f2f4f7' };
    doc.autoTable({
      startY: y, margin: { left: M, right: M, top: 20 }, head: [ETQ],
      body: det.linhas.map(function (l) { return COLS.map(function (i) { var v = l[i]; return typeof v === 'number' ? fmt(v) : (v == null ? '' : v); }); }),
      styles: Object.assign({}, estilo, { fontSize: 6.3, cellPadding: 1 }), headStyles: Object.assign({}, cabEstilo, { fontSize: 6.5 }),
      columnStyles: { 8: { cellWidth: 30 }, 2: { cellWidth: 20 } },
      didParseCell: function (h) {
        if (h.section === 'body' && h.column.index === 14 && cores[h.cell.raw]) h.cell.styles.fillColor = rgb(cores[h.cell.raw]);
        if (h.section === 'body' && h.column.index === 12 && h.cell.raw === 'sem baixa') h.cell.styles.textColor = [180, 35, 24];
      },
      didDrawPage: function () { cabecalho('Detalhe'); }
    });

    var total = doc.internal.getNumberOfPages();
    for (var p = 1; p <= total; p++) {
      doc.setPage(p);
      doc.setFontSize(7); doc.setTextColor(152, 162, 179);
      doc.text('Página ' + p + ' de ' + total + ' · prazos em dias úteis (d.u.)', L - M, A - 5, { align: 'right' });
      if ((d.avisos || []).length && p === 1) doc.text(String(d.avisos[0]).slice(0, 190), M, A - 5);
    }
    doc.save(nomeArquivo('pdf'));
  }

  function abrirSla() {
    var d = estado.dados;
    if (!d) return;
    var cfg = d.slaConfig || {};
    var html = '<table><thead><tr><th>Etapa</th><th>Responsável</th><th class="num">Meta geral</th></tr></thead><tbody>' +
      d.etapas.map(function (e) { return '<tr><td>' + esc(e.nome) + '</td><td>' + esc(e.responsavel) + '</td><td class="num">' + (e.id === 'pagamento' ? 'até o vencimento + ' + d.sla[e.id] : d.sla[e.id]) + '</td></tr>'; }).join('') +
      '</tbody></table>';
    var extras = [];
    Object.keys(cfg.prioridade || {}).forEach(function (k) { extras.push('Prioridade ' + k + ': ' + JSON.stringify(cfg.prioridade[k])); });
    Object.keys(cfg.departamento || {}).forEach(function (k) { extras.push('Departamento ' + k + ': ' + JSON.stringify(cfg.departamento[k])); });
    if ((cfg.feriados || []).length) extras.push('Feriados: ' + cfg.feriados.length);
    if (extras.length) html += '<p class="sub" style="margin-top:10px">' + extras.map(esc).join('<br>') + '</p>';
    $('sla-corpo').innerHTML = html;
    $('dlg-sla').showModal();
  }

  lerFiltrosDaUrl();
  $('bt-atualizar').onclick = carregar;
  $('bt-xlsx').onclick = function () { exportar('xlsx', exportarExcel); };
  $('bt-pdf').onclick = function () { exportar('pdf', exportarPdf); };
  $('bt-sla').onclick = abrirSla;
  ['busca'].forEach(function (id) { $(id).addEventListener('input', function () { estado.pagina = 1; renderDetalhe(); }); });
  ['f-etapa', 'f-etapa-sit'].forEach(function (id) { $(id).addEventListener('change', function () { estado.pagina = 1; estado.etapaSel = $('f-etapa').value; renderFluxo(estado.dados); renderDetalhe(); }); });
  carregar();
})();
</script>
</body>
</html>`

    return { onRequest }
})
