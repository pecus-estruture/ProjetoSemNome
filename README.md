# PECUS Consultoria em Licitações

Aplicação Node.js + Express para pesquisar resultados públicos do PNCP, identificar fornecedores não vencedores e gerar uma visão de prospecção comercial.

## Executar localmente

```bash
npm install
cp .env.example .env
npm start
```

Abra `http://localhost:3000`.

## Variáveis de ambiente

- `PNCP_API_BASE_URL` (ou `PNCP_API_URL`): base da API de consulta do PNCP. O padrão é `https://pncp.gov.br/api/consulta`. A busca usa `GET /v1/contratacoes/atualizacao`, `codigoModalidadeContratacao=6` (Pregão Eletrônico) e `pagina=1`.
- `PNCP_DATA_API_BASE_URL` (ou `PNCP_API_DATA_BASE_URL`): base para itens, resultados e histórico. O padrão é derivado como `https://pncp.gov.br/api/pncp/v1`.
- `NVIDIA_API_KEY`: chave NVIDIA para resumir cada ocorrência em uma frase. `NVIDIA_API_URL` (ou `NVIDIA_API_BASE_URL`) e `NVIDIA_MODEL` são opcionais.
- `GOOGLE_SHEETS_WEBHOOK_URL` (ou `GOOGLE_SHEETS_URL`): endpoint que recebe `POST` com `{ action, filtros, leads }` e responde a `GET` com os leads salvos. Sem a variável, a aplicação continua funcionando apenas em memória.
- `TELEGRAM_API_BASE_URL` (ou `TELEGRAM_API_URL`), `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`: envio do resumo da pesquisa para o Telegram.
- `PORT`: porta HTTP, definida automaticamente pelo Render quando disponível.
- `MAX_LEADS` e `PNCP_MAX_CONTRATACOES`: limites operacionais opcionais.
- `MAX_SEARCH_DAYS`: limite do período informado pelo usuário; padrão de 366 dias. O backend divide automaticamente o período em janelas de até 31 dias para consultar o PNCP.
- `PNCP_UPDATE_MAX_PAGES`: páginas consultadas por janela na API de atualização; padrão 10.
- `PNCP_REQUEST_TIMEOUT_MS`: timeout de cada chamada ao PNCP, com nova tentativa automática em falhas transitórias; padrão 90000 ms.

O webhook da planilha deve aceitar o lote enviado pela aplicação. Cada lead contém fornecedor, identificação, objeto, classificação, ocorrência, resumo da IA, órgão, data e link do PNCP. A implementação do webhook pode fazer `upsert` usando o campo `id`.

## Escopos da pesquisa

`POST /api/buscar` aceita `escopo` como `estado`, `cidade` ou `federal`. O escopo estadual usa `uf`; o municipal usa `uf` com `cidade` e/ou `codigoMunicipioIbge`; o federal consulta sem UF e filtra órgãos cuja esfera seja federal.

## Deploy no Render

Crie um Web Service apontando para este repositório, com:

- Build command: `npm install`
- Start command: `npm start`

Configure as variáveis do `.env.example` no painel do Render. O código não depende de arquivo `.env` no Render: todas as chamadas externas usam `process.env` e o serviço escuta a porta fornecida por `process.env.PORT`. Depois, crie o secret `RENDER_URL` no GitHub Actions com a URL pública do serviço, por exemplo `https://sua-aplicacao.onrender.com`.

## Workflow diário

`.github/workflows/cron-diario.yml` roda às 10:00 UTC (07:00 em Brasília), envia `escopo=estado`, `UF=GO` e pesquisa o dia anterior. Se `CRON_SECRET` estiver definido no GitHub e no Render, o workflow também envia o header `Authorization: Bearer ...`.
