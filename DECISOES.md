# p2p-sla — decisões

Painel gerencial (Suitelet) do SLA do procure-to-pay por departamento, nas fases do Manual de Procedimentos
de Compras MPI-SUP-001 de 03/08/2026, item 4 (D7): Requisição → aprovação → Bid e convites → Propostas →
Negociação → Pedido de compra → aprovação → Entrega e recebimento → Lançamento da NF → Pagamento. Somente
leitura, SuiteQL.

| Arquivo | Papel |
|---|---|
| `src/FileCabinet/SuiteScripts/P2P-SLA/GLO_P2P_SLA_Lib.js` | Regra: marcos, etapas, SLA, agregados. Pura, testada. |
| `src/FileCabinet/SuiteScripts/P2P-SLA/GLO_P2P_SLA_SL.js` | Consultas, `action=dados` (JSON) e a página (Chart.js 4.4.1, cdnjs). |
| `src/Objects/customscript_glo_p2p_sla_sl.xml` | Script, parâmetro `custscript_glo_p2p_sla_config_ip`, deployment `customdeploy_glo_p2p_sla_sl`. |

Testes: `node --test "__tests__/*.test.js"`.

## D1. Unidade de análise: par requisição × pedido

Uma requisição gera mais de um pedido (472 requisições → 613 pedidos em produção, 19/10/2026). Cada par é um
ciclo; requisição sem pedido é um ciclo com `po = null`. A aprovação da requisição conta **uma vez por
requisição** nos agregados (`primeiroDaReq`), as demais etapas uma vez por pedido.

## D2. De onde sai cada data

| Marco | Fonte | Por quê |
|---|---|---|
| Abertura da requisição / do pedido / lançamento da NF | `createddate` | `trandate` pode ser digitado retroativo |
| Aprovação da requisição e do pedido | `systemnote`, campo `TRANDOC.KSTATUS`: primeira saída de "Aprovação do supervisor pendente" | não há campo de data de aprovação; a nota guarda quem e quando |
| Recebimento | `trandate` do primeiro Item Receipt (`ShipRcpt`) | é a data física da entrada |
| Pagamento | `trandate` do último Bill Payment (`Payment`) quando a conta está paga (`status = 'B'`) | |

Documento que nasce sem passar por "Aprovação … pendente" é **aprovação automática**: etapa com 0 dia, fora
dos rankings de aprovador. O texto do status vem no idioma da conta; a regra casa português e inglês.
Volta para aprovação depois de editado conta em `reaprovacoes`; vale a **primeira** aprovação.

Vínculos medidos em `previoustransactionlink`: `POrdReq` (requisição → pedido), `ShipRcpt` (pedido →
recebimento), `OrdBill`/`ShipRcpt` (pedido → conta a pagar), `Payment` (conta → pagamento).

## D3. Etapas e responsáveis

| Fase do manual | Etapa | De → até | Responsável | Meta padrão (dias úteis) |
|---|---|---|---|---|
| 4.1 | Aprovação da requisição | abertura → aprovação | Gestor do departamento | 2 |
| 4.2 | Bid e convites | aprovação da requisição → envio dos convites | Compras | 2 |
| 4.2 | Propostas dos fornecedores | envio dos convites → última proposta | Fornecedores | 3 |
| 4.3 | Negociação | última proposta → última rodada de negociação | Compras | 3 |
| 4.4 | Emissão do pedido | última rodada (ou proposta; sem Bid, aprovação da requisição) → abertura do PO | Compras | 3 |
| 4.5 | Aprovação do pedido | abertura → aprovação do PO | Head de Compras | 2 |
| 4.6 a 4.8 | Entrega e recebimento | aprovação do PO → recebimento | Fornecedor / Compras / Logística | 15 |
| 4.9 | Lançamento da NF | recebimento → conta a pagar | Fiscal / Contas a pagar | 3 |
| 4.9 | Pagamento | pagamento × vencimento de cada conta | Financeiro | 0 (tolerância após o vencimento) |

Aprovação da requisição, Bid, propostas e negociação contam uma vez por requisição (`porRequisicao`); as demais,
uma vez por pedido. O manual não fixa prazo por fase.

Pedido de **serviço** (com conta a pagar e sem recebimento): entrega "não se aplica" e o lançamento conta da
aprovação do pedido.

Dias úteis: sábado, domingo e `feriados` da configuração fora, fracionado por hora. Metas no parâmetro
`custscript_glo_p2p_sla_config_ip` (JSON); precedência geral < `prioridade[id]` < `departamento[id]`. As
metas padrão são ponto de partida, não acordo de nível de serviço aprovado pelas áreas.

## D4. Pagamento não registrado não vira pago

Conta a pagar aberta com vencimento passado é **atrasada / sem baixa**, nunca paga. Retrato de produção em
19/10/2026: das 276 contas a pagar de pedidos de 2026, 272 estão abertas; os Bill Payments de 2026 são quase
todos reembolso de relatório de despesas, e a remessa CNAB de pagamento parou em 02/02/2026 (as remessas
seguintes são de boletos de cobrança). Enquanto o Financeiro não baixar os pagamentos no NetSuite, a etapa
Pagamento mede o atraso de baixa, e o painel avisa a quantidade.

## D5. Execução e governança

Deployment como Administrador: o perfil do usuário pode não ver Requisição (o da integração não via). O
público do deployment decide quem abre o painel. Pedidos e contas são lidos em lotes de 900 ids
(`IN (...)`); subconsulta encadeada pedido → conta → pagamento travou a leitura no navegador. Abaixo de 60
unidades a leitura para e a resposta volta `truncado = true`, mostrado como aviso.

A agregação roda no servidor (na biblioteca testada); a página só desenha.

## D6. Exportação: Excel e PDF, sem CSV

Geradas no navegador a partir dos dados já carregados, sem nova leitura no NetSuite. SheetJS 0.18.5, jsPDF
2.5.1 e jspdf-autotable 3.8.2 do cdnjs, carregados só no primeiro clique. Excel: abas Resumo, Etapas,
Departamentos, Mensal, Responsáveis e Detalhe (números como número, filtro no cabeçalho). PDF A4 paisagem:
resumo com indicadores, departamentos, evolução, responsáveis e detalhe; gráficos em JPEG (em PNG o arquivo
passava de 7 MB). O detalhe exportado respeita a busca e o filtro de etapa da tabela. Filtro de departamento,
subsidiária, prioridade e situação refaz a leitura do período.

## D7. Fases do manual de Compras: Bid, propostas e negociação

O manual MPI-SUP-001 (03/08/2026) põe entre a requisição aprovada e o pedido a fase de mercado (4.2: Bid,
convites, no mínimo 3 cotações — item 7.1) e a negociação (4.3). No NetSuite elas acontecem no projeto
P2P - Req; o painel lê os registros dele em vez de manter o intervalo inteiro como "Emissão do pedido".

| Marco | Fonte |
|---|---|
| Convites enviados | `customrecord_gl_bid.custrecord_gl_bid_dt_envio` do primeiro Bid enviado da requisição (`custrecord_gl_bid_requisicao`) |
| Propostas | última `custrecord_gl_bidforn_dt_resp` dos convidados (`customrecord_gl_bid_forn`), quando todos responderam ou quando Compras seguiu (há rodada 2+ ou pedido) |
| Negociado | última `custrecord_gl_neg_data` de rodada 2 em diante (`customrecord_gl_bid_neg_rodada`); a rodada 1 é a proposta inicial |

- **Escolha do vencedor não tem data.** A Cotação vira "Vencedor" (`custrecord_gl_cot_status` = 2) sem
  nota de sistema: em 09/11/2026 o `systemnote` dos tipos 4583 e 4587 estava vazio em produção. A fase 4.3
  fecha na última rodada, e a escolha do vencedor fica dentro da emissão do pedido.
- **Sem Bid** (requisição sem Bid, ou Bid nunca enviado e pedido já emitido): as três fases ficam `sem_bid`,
  a emissão conta da aprovação da requisição e a requisição conta no indicador "pedido sem Bid".
- **Bid enviado, nenhuma proposta e pedido emitido:** propostas `encerrada`, negociação `nao_se_aplica`.
- **Pedido com Bid e sem rodada 2:** negociação `nao_se_aplica`; a emissão conta da última proposta.
- **Conformidade** nos indicadores: requisições com no mínimo 3 propostas (`MINIMO_COTACOES`) e pedidos com
  pagamento registrado antes do recebimento (manual 4.9).
- O link do Bid na tabela usa o `internalid` do tipo `CUSTOMRECORD_GL_BID`, lido na consulta: varia por conta.
- Conta sem o projeto P2P - Req: a consulta de Bid falha, o painel segue com as fases em `sem_bid` e avisa.
