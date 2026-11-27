import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const env = (primary, ...aliases) => {
  for (const name of [primary, ...aliases]) {
    if (process.env[name]?.trim()) return process.env[name].trim();
  }
  return "";
};

const PORT = Number(process.env.PORT || 3000);
const PNCP_API_BASE_URL = (env("PNCP_API_BASE_URL", "PNCP_API_URL") || "https://pncp.gov.br/api/consulta").replace(/\/+$/, "");
const PNCP_DATA_API_BASE_URL = (env("PNCP_DATA_API_BASE_URL", "PNCP_API_DATA_BASE_URL") || `${new URL(PNCP_API_BASE_URL).origin}/api/pncp/v1`).replace(/\/+$/, "");
const NVIDIA_API_URL = env("NVIDIA_API_URL", "NVIDIA_API_BASE_URL") || "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_API_KEY = env("NVIDIA_API_KEY");
const NVIDIA_MODEL = env("NVIDIA_MODEL") || "meta/llama-3.1-8b-instruct";
const GOOGLE_SHEETS_WEBHOOK_URL = env("GOOGLE_SHEETS_WEBHOOK_URL", "GOOGLE_SHEETS_URL");
const TELEGRAM_API_BASE_URL = (env("TELEGRAM_API_BASE_URL", "TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/+$/, "");
const TELEGRAM_BOT_TOKEN = env("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = env("TELEGRAM_CHAT_ID");
const MAX_LEADS = Math.max(1, Number(process.env.MAX_LEADS || 200));
const MAX_CONTRATACOES = Math.max(1, Number(process.env.PNCP_MAX_CONTRATACOES || 300));
const MAX_SEARCH_DAYS = Math.max(31, Number(process.env.MAX_SEARCH_DAYS || 730));
const PNCP_DATE_WINDOW_DAYS = 31;
const PNCP_UPDATE_MAX_PAGES = Math.max(1, Number(process.env.PNCP_UPDATE_MAX_PAGES || 20));
const PNCP_REQUEST_TIMEOUT_MS = Math.max(30000, Number(process.env.PNCP_REQUEST_TIMEOUT_MS || 90000));
const PNCP_PUBLICATION_FALLBACK = env("PNCP_PUBLICATION_FALLBACK") !== "false";
const PNCP_UPDATE_FALLBACK_TIMEOUT_MS = Math.max(10000, Number(process.env.PNCP_UPDATE_FALLBACK_TIMEOUT_MS || 15000));
const PNCP_PUBLICATION_TIMEOUT_MS = Math.max(15000, Number(process.env.PNCP_PUBLICATION_TIMEOUT_MS || 30000));
const PNCP_DATA_REQUEST_TIMEOUT_MS = Math.max(10000, Number(process.env.PNCP_DATA_REQUEST_TIMEOUT_MS || 20000));
const PNCP_MIN_INTERVAL_MS = Math.max(0, Number(process.env.PNCP_MIN_INTERVAL_MS || 250));
const PNCP_RATE_LIMIT_COOLDOWN_MS = Math.max(1000, Number(process.env.PNCP_RATE_LIMIT_COOLDOWN_MS || 10000));
const PNCP_PRIMARY_SOURCE = env("PNCP_PRIMARY_SOURCE") === "atualizacao" ? "atualizacao" : "publicacao";
const PNCP_MODALIDADE_PREGAO_ELETRONICO = 6;
const IBGE_API_BASE_URL = (env("IBGE_API_BASE_URL") || "https://servicodados.ibge.gov.br/api/v1/localidades/estados").replace(/\/+$/, "");
const municipalityCache = new Map();
let pncpNextRequestAt = 0;
let pncpRateLimitUntil = 0;
let pncpRequestGate = Promise.resolve();
let nvidiaSkippedLogged = false;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function httpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validateDate(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw httpError(`${fieldName} deve estar no formato YYYY-MM-DD.`, 400);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw httpError(`${fieldName} não é uma data válida.`, 400);
  }

  return value;
}

function validateSearchInput(body = {}) {
  const escopo = String(body.escopo || "estado").trim().toLowerCase();
  if (!["cidade", "estado", "federal"].includes(escopo)) {
    throw httpError("escopo deve ser cidade, estado ou federal.", 400);
  }

  const uf = escopo === "federal" ? "" : String(body.uf || "GO").trim().toUpperCase();
  if (escopo !== "federal" && !/^[A-Z]{2}$/.test(uf)) {
    throw httpError("UF deve conter exatamente duas letras.", 400);
  }

  const cidade = String(body.cidade || "").trim();
  const codigoMunicipioIbge = cleanDigits(body.codigoMunicipioIbge);
  if (escopo === "cidade" && !cidade && !codigoMunicipioIbge) {
    throw httpError("Informe a cidade ou o código IBGE para pesquisar por cidade.", 400);
  }
  if (codigoMunicipioIbge && codigoMunicipioIbge.length !== 7) {
    throw httpError("O código IBGE deve conter 7 dígitos.", 400);
  }

  const dataInicial = validateDate(body.dataInicial, "dataInicial");
  const dataFinal = validateDate(body.dataFinal, "dataFinal");
  const start = new Date(`${dataInicial}T00:00:00.000Z`);
  const end = new Date(`${dataFinal}T00:00:00.000Z`);
  const days = Math.round((end - start) / 86400000);

  if (days < 0) {
    throw httpError("dataFinal deve ser igual ou posterior a dataInicial.", 400);
  }
  if (days > MAX_SEARCH_DAYS) {
    throw httpError(`O período máximo de pesquisa é de ${MAX_SEARCH_DAYS} dias.`, 400);
  }

  const status = String(body.status || "todos").trim().toLowerCase();
  if (!["a_receber", "julgamento", "encerradas", "todos"].includes(status)) {
    throw httpError("Status de contratação inválido.", 400);
  }

  return {
    escopo,
    uf,
    cidade,
    codigoMunicipioIbge,
    dataInicial,
    dataFinal,
    palavraChave: String(body.palavraChave || "").trim(),
    status,
    tipoInstrumentoConvocatorio: String(body.tipoInstrumentoConvocatorio || "").trim(),
    anoContratacao: String(body.anoContratacao || "").trim(),
    modalidade: String(body.modalidade || PNCP_MODALIDADE_PREGAO_ELETRONICO).trim(),
    orgao: String(body.orgao || "").trim(),
    unidade: String(body.unidade || "").trim(),
    esfera: String(body.esfera || "").trim(),
    poder: String(body.poder || "").trim(),
    fonte: String(body.fonte || "").trim(),
    emendaParlamentar: String(body.emendaParlamentar || "").trim(),
    normativoBase: String(body.normativoBase || "").trim(),
    amparoLegal: String(body.amparoLegal || "").trim(),
    modoDisputa: String(body.modoDisputa || "").trim(),
    criterioJulgamento: String(body.criterioJulgamento || "").trim(),
    fornecedor: String(body.fornecedor || "").trim(),
    itemSigiloso: String(body.itemSigiloso || "").trim(),
    notaFiscalEletronica: String(body.notaFiscalEletronica || "").trim()
  };
}

function makeUrl(base, pathname, params = {}) {
  const url = new URL(`${base}${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function safeUrlForLog(value) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/bot[^/]+/i, "/bot[redacted]");
    url.search = "";
    return url.toString();
  } catch {
    return "URL externa";
  }
}

async function request(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "PECUS-Consultoria-Licitacoes/1.0",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
      const error = httpError(`HTTP ${response.status} em ${safeUrlForLog(url)}: ${detail}`, response.status);
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        error.retryAfterMs = Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0;
      }
      throw error;
    }

    return { status: response.status, body };
  } catch (error) {
    if (error.name === "AbortError") {
      throw httpError(`Tempo esgotado ao consultar ${safeUrlForLog(url)}.`, 504);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryable(error) {
  return error?.name === "AbortError" || [408, 429, 500, 502, 503, 504].includes(error?.status);
}

async function requestWithRetry(url, options = {}, timeoutMs = 30000, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await request(url, options, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) throw error;
      const retryDelay = error.status === 429 ? Math.max(error.retryAfterMs || 0, 10000) : attempt * 1500;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
  throw lastError;
}

async function pncpRequest(url, { timeoutMs = PNCP_REQUEST_TIMEOUT_MS, attempts = 2 } = {}) {
  let releaseGate;
  const previousRequest = pncpRequestGate;
  pncpRequestGate = new Promise((resolve) => { releaseGate = resolve; });
  await previousRequest;

  try {
    const waitMs = Math.max(pncpNextRequestAt, pncpRateLimitUntil) - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    pncpNextRequestAt = Date.now() + PNCP_MIN_INTERVAL_MS;
  } finally {
    releaseGate();
  }

  try {
    return await requestWithRetry(url, {}, timeoutMs, attempts);
  } catch (error) {
    if (error.status === 429) {
      pncpRateLimitUntil = Date.now() + Math.max(PNCP_RATE_LIMIT_COOLDOWN_MS, error.retryAfterMs || 0);
    }
    throw error;
  }
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const wrapped = promise
    .then((value) => ({ status: "fulfilled", value }))
    .catch((reason) => ({ status: "rejected", reason }));
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timedout" }), timeoutMs);
  });
  const result = await Promise.race([wrapped, timeout]);
  clearTimeout(timer);
  return result;
}

function asList(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  for (const key of preferredKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  for (const key of ["data", "content", "items", "itens", "results", "resultados", "elements", "elementos", "rows", "leads"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  return [];
}

function firstValue(object, keys) {
  if (!object || typeof object !== "object") return "";
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

function cleanDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function hasFilterValue(value) {
  return Boolean(value && normalizeText(value) !== "todos" && normalizeText(value) !== "selecione");
}

function matchesTextFilter(value, filter) {
  return !hasFilterValue(filter) || normalizeText(value).includes(normalizeText(filter));
}

function booleanValue(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeText(value);
  if (["true", "1", "sim", "yes"].includes(normalized)) return true;
  if (["false", "0", "nao", "não", "no"].includes(normalized)) return false;
  return null;
}

function sphereCode(value) {
  const normalized = normalizeText(value);
  if (/^(f|federal)$/.test(normalized)) return "F";
  if (/^(e|estadual)$/.test(normalized)) return "E";
  if (/^(m|municipal)$/.test(normalized)) return "M";
  if (/^(d|distrital)$/.test(normalized)) return "D";
  return "";
}

function powerCode(value) {
  const normalized = normalizeText(value);
  if (/^(e|executivo)$/.test(normalized)) return "E";
  if (/^(l|legislativo)$/.test(normalized)) return "L";
  if (/^(j|judiciario|judiciário)$/.test(normalized)) return "J";
  return "";
}

function officialSphere(contract) {
  const orgao = contract?.orgaoEntidade || contract?.orgao || {};
  return sphereCode(firstValue(orgao, ["esferaId", "esferaNome", "esfera"]));
}

function officialPower(contract) {
  const orgao = contract?.orgaoEntidade || contract?.orgao || {};
  return powerCode(firstValue(orgao, ["poderId", "poderNome", "poder"]));
}

function officialUf(contract) {
  const unidade = contract?.unidadeOrgao || {};
  return String(firstValue(unidade, ["ufSigla", "uf"]) || firstValue(contract, ["uf", "unidadeFederativa"]) || "").trim().toUpperCase();
}

function officialMunicipalityCode(contract) {
  const unidade = contract?.unidadeOrgao || {};
  return cleanDigits(firstValue(unidade, ["codigoIbge", "municipioId", "codigoMunicipioIbge"]));
}

function officialMunicipalityName(contract) {
  const unidade = contract?.unidadeOrgao || {};
  return String(firstValue(unidade, ["municipioNome", "municipio", "nomeMunicipio"]) || "").trim();
}

function contractStatusCategory(contract) {
  const statusName = normalizeText(firstValue(contract, ["situacaoCompraNome", "situacaoNome"]));
  const hasResult = booleanValue(firstValue(contract, ["existeResultado", "temResultado", "temResultados", "possuiResultado"]));
  const homologatedValue = Number(firstValue(contract, ["valorTotalHomologado", "valorHomologado"]));
  if (hasResult === true || homologatedValue > 0 || /homologad|adjudicad|finalizad|concluid|encerrad/.test(statusName)) {
    return "encerradas";
  }

  const statusId = Number(firstValue(contract, ["situacaoCompraId", "situacaoId"]));
  if ([2, 3, 4].includes(statusId) || /revogad|anulad|suspend/.test(statusName)) return "encerradas";

  const opening = Date.parse(String(firstValue(contract, ["dataAberturaProposta"]) || ""));
  const closing = Date.parse(String(firstValue(contract, ["dataEncerramentoProposta"]) || ""));
  const now = Date.now();
  if (Number.isFinite(opening) && Number.isFinite(closing) && opening <= now && closing > now) return "a_receber";
  if (Number.isFinite(closing) && closing <= now) return "julgamento";

  if (/recebendo proposta|recebimento de proposta|aberta/.test(statusName)) return "a_receber";
  if (/em julgamento|propostas encerradas|julgament/.test(statusName)) return "julgamento";
  return "";
}

function contractStatusMatchesWithItems(contract, status, items, itemResults) {
  if (!hasFilterValue(status)) return true;
  const category = contractStatusCategory(contract);
  const hasItemResult = itemResults.some(({ results }) => results.length > 0)
    || items.some((item) => booleanValue(item?.temResultado) === true);

  if (status === "encerradas") {
    return hasItemResult || category === "encerradas" || !category;
  }
  if (status === "a_receber") {
    return !hasItemResult && category !== "encerradas" && category !== "julgamento";
  }
  if (status === "julgamento") {
    return !hasItemResult && category !== "encerradas" && category !== "a_receber";
  }
  return true;
}

function getContractIdentity(contract) {
  const orgao = contract?.orgaoEntidade || contract?.orgao || contract?.entidade || {};
  let cnpj = cleanDigits(firstValue(contract, ["cnpjOrgao", "cnpj", "cnpjEntidade"]) || firstValue(orgao, ["cnpj", "cnpjOrgao"]));
  let ano = firstValue(contract, ["anoCompra", "anoContratacao", "ano"]);
  let sequencial = firstValue(contract, ["sequencialCompra", "sequencialContratacao", "sequencial"]);
  const control = String(firstValue(contract, ["numeroControlePNCP", "numeroControle", "id"]));

  if ((!cnpj || !ano || !sequencial) && control) {
    const slashFormat = control.match(/^(\d{14})-\d+-([0-9]+)\/(\d{4})$/);
    const dashFormat = control.match(/^(\d{14})-\d+-(\d{4})-([0-9]+)$/);
    const match = slashFormat || dashFormat;
    if (match) {
      cnpj ||= match[1];
      if (slashFormat) {
        sequencial ||= match[2];
        ano ||= match[3];
      } else {
        ano ||= match[2];
        sequencial ||= match[3];
      }
    }
  }

  if (!cnpj || !ano || !sequencial) return null;
  return { cnpj, ano: String(ano), sequencial: String(sequencial) };
}

async function fetchPaginated(pathname, params, { pageSize = 50, maxPages = 10, maxItems = Infinity, baseUrl = PNCP_API_BASE_URL, timeoutMs = PNCP_REQUEST_TIMEOUT_MS, attempts = 2 } = {}) {
  const output = [];
  for (let page = 1; page <= maxPages && output.length < maxItems; page += 1) {
    const url = makeUrl(baseUrl, pathname, {
      ...params,
      pagina: page,
      tamanhoPagina: pageSize
    });
    const { body } = await pncpRequest(url, { timeoutMs, attempts });
    const rows = asList(body);
    output.push(...rows);

    const total = Number(firstValue(body, ["totalRegistros", "total", "totalElements", "count"]));
    if (!rows.length || (total && output.length >= total) || rows.length < pageSize) break;
  }
  return output.slice(0, maxItems);
}

async function fetchItems(identity, contract) {
  if (Array.isArray(contract?.itens)) return contract.itens;
  const params = {};
  return fetchPaginated(`/orgaos/${identity.cnpj}/compras/${identity.ano}/${identity.sequencial}/itens`, params, {
    pageSize: 50,
    maxPages: 20,
    maxItems: 2000,
    baseUrl: PNCP_DATA_API_BASE_URL,
    timeoutMs: PNCP_DATA_REQUEST_TIMEOUT_MS
  });
}

async function fetchResults(identity, item) {
  if (Array.isArray(item?.resultados)) return item.resultados;
  const numeroItem = firstValue(item, ["numeroItem", "itemNumero", "numero"]);
  if (!numeroItem) return [];
  const url = makeUrl(
    PNCP_DATA_API_BASE_URL,
    `/orgaos/${identity.cnpj}/compras/${identity.ano}/${identity.sequencial}/itens/${numeroItem}/resultados`
  );
  const { body } = await pncpRequest(url, { timeoutMs: PNCP_DATA_REQUEST_TIMEOUT_MS });
  return asList(body, ["listaResultados", "resultados"]);
}

async function fetchHistory(identity) {
  try {
    const url = makeUrl(PNCP_DATA_API_BASE_URL, `/orgaos/${identity.cnpj}/compras/${identity.ano}/${identity.sequencial}/historico`);
    const { body } = await pncpRequest(url, { timeoutMs: PNCP_DATA_REQUEST_TIMEOUT_MS });
    return asList(body, ["historico", "historicos", "logs"]);
  } catch (error) {
    console.warn("Histórico PNCP indisponível:", error.message);
    return [];
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return output;
}

function resultClassification(result) {
  const value = firstValue(result, ["ordemClassificacaoSrp", "ordemClassificacao", "classificacao", "colocacao", "posicao"]);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resultStatus(result) {
  return String(firstValue(result, [
    "situacaoCompraItemResultadoNome",
    "situacaoResultadoNome",
    "situacaoResultado",
    "status",
    "motivo",
    "justificativa",
    "observacao",
    "ocorrencia"
  ]) || "").trim();
}

function isLosingResult(result) {
  const classification = resultClassification(result);
  const status = resultStatus(result).toLocaleLowerCase("pt-BR");
  return (classification === 2 || classification === 3) || /inabilitad|desclassificad|eliminad|rejeitad|inapt|cancelad/.test(status);
}

function ordinal(value) {
  if (value === 1) return "1º";
  if (value === 2) return "2º";
  if (value === 3) return "3º";
  return `${value}º`;
}

function findHistoryReason(history, result) {
  if (!history.length) return "";
  const supplierId = cleanDigits(firstValue(result, ["niFornecedor", "cnpjFornecedor", "cpfFornecedor"]));
  const supplierName = String(firstValue(result, ["nomeRazaoSocialFornecedor", "razaoSocialFornecedor", "nomeFornecedor"]) || "").toLocaleLowerCase("pt-BR");
  const candidate = history.find((event) => {
    const text = JSON.stringify(event).toLocaleLowerCase("pt-BR");
    const mentionsSupplier = (supplierId && text.includes(supplierId)) || (supplierName && text.includes(supplierName));
    return mentionsSupplier && /inabilitad|desclassificad|eliminad|rejeitad|motivo|justificativ|ocorr/.test(text);
  });

  return String(firstValue(candidate, ["justificativa", "motivo", "ocorrencia", "descricao"]) || "").trim();
}

function buildOccurrence(result, history) {
  const status = resultStatus(result);
  const historyReason = findHistoryReason(history, result);
  if (historyReason) return historyReason;
  if (status && /inabilitad|desclassificad|eliminad|rejeitad|inapt|cancelad/i.test(status)) return status;

  const classification = resultClassification(result);
  if (classification && classification > 1) {
    return `Fornecedor classificado em ${ordinal(classification)} lugar, atrás do vencedor.`;
  }
  return "Fornecedor sem vitória registrada no resultado consultado.";
}

function contractTitle(contract, item) {
  return String(firstValue(item, ["descricao", "descricaoItem", "objeto"]) || firstValue(contract, ["objetoCompra", "objeto", "descricaoObjeto", "titulo"] ) || "Objeto não informado").trim();
}

function isoDateFromUtc(date) {
  return date.toISOString().slice(0, 10);
}

function splitDateRange(dataInicial, dataFinal, windowDays = PNCP_DATE_WINDOW_DAYS) {
  const ranges = [];
  const end = new Date(`${dataFinal}T00:00:00.000Z`);
  let cursor = new Date(`${dataInicial}T00:00:00.000Z`);

  while (cursor <= end) {
    const windowEnd = new Date(cursor);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + windowDays - 1);
    if (windowEnd > end) windowEnd.setTime(end.getTime());
    ranges.push({ dataInicial: isoDateFromUtc(cursor), dataFinal: isoDateFromUtc(windowEnd) });
    cursor = new Date(windowEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return ranges;
}

function pncpSearchParams(filters, range) {
  return {
    dataInicial: range.dataInicial.replaceAll("-", ""),
    dataFinal: range.dataFinal.replaceAll("-", ""),
    codigoModalidadeContratacao: filters.modalidade === "todos" ? PNCP_MODALIDADE_PREGAO_ELETRONICO : filters.modalidade,
    ...(hasFilterValue(filters.modoDisputa) ? { codigoModoDisputa: filters.modoDisputa } : {}),
    ...(filters.uf ? { uf: filters.uf } : {}),
    ...(filters.codigoMunicipioIbge ? { codigoMunicipioIbge: filters.codigoMunicipioIbge } : {}),
    ...(hasFilterValue(filters.orgao) && /^\d{14}$/.test(cleanDigits(filters.orgao)) ? { cnpj: cleanDigits(filters.orgao) } : {}),
    ...(hasFilterValue(filters.unidade) && !/\s/.test(filters.unidade) ? { codigoUnidadeAdministrativa: filters.unidade } : {})
  };
}

async function fetchContractsForWindow(filters, range) {
  const params = pncpSearchParams(filters, range);
  const publicationParams = { ...params };
  delete publicationParams.codigoModoDisputa;

  const sourceRequests = {
    publicacao: {
      pathname: "/v1/contratacoes/publicacao",
      params: publicationParams,
      timeoutMs: PNCP_PUBLICATION_TIMEOUT_MS,
      timeoutMessage: "A consulta de publicação do PNCP excedeu o tempo limite."
    },
    atualizacao: {
      pathname: "/v1/contratacoes/atualizacao",
      params,
      timeoutMs: PNCP_UPDATE_FALLBACK_TIMEOUT_MS,
      timeoutMessage: "A consulta de atualização do PNCP excedeu o tempo de fallback."
    }
  };
  const primaryName = PNCP_PRIMARY_SOURCE;
  const fallbackName = primaryName === "publicacao" ? "atualizacao" : "publicacao";
  const sourceResult = async (name) => {
    const source = sourceRequests[name];
    const result = await settleWithin(fetchPaginated(source.pathname, source.params, {
      pageSize: 50,
      maxPages: PNCP_UPDATE_MAX_PAGES,
      maxItems: MAX_CONTRATACOES,
      timeoutMs: source.timeoutMs,
      attempts: 1
    }), source.timeoutMs);
    return { name, source, result };
  };

  // A publicação é mais adequada para pesquisas históricas. As fontes são
  // consultadas em sequência para não dobrar a carga no PNCP nem gerar 429.
  const primary = await sourceResult(primaryName);
  if (primary.result.status === "fulfilled" && primary.result.value.length) {
    return { contracts: primary.result.value, errors: [] };
  }

  if (!PNCP_PUBLICATION_FALLBACK) {
    return {
      contracts: primary.result.status === "fulfilled" ? primary.result.value : [],
      errors: [sourceError(primary)].filter(Boolean)
    };
  }

  const fallback = await sourceResult(fallbackName);
  if (fallback.result.status === "fulfilled") {
    return { contracts: fallback.result.value, errors: [] };
  }

  return {
    contracts: [],
    errors: [sourceError(primary), sourceError(fallback)].filter(Boolean)
  };
}

function sourceError(sourceResult) {
  if (sourceResult.result.status === "timedout") return httpError(sourceResult.source.timeoutMessage, 504);
  if (sourceResult.result.status === "rejected") return sourceResult.result.reason;
  return null;
}

function contractMatchesScope(contract, filters) {
  const contractUf = officialUf(contract);

  if (filters.escopo === "estado") return contractUf === filters.uf && officialSphere(contract) === "E";

  if (filters.escopo === "cidade") {
    const contractIbge = officialMunicipalityCode(contract);
    const requestedCity = normalizeText(filters.cidade);
    const contractCity = normalizeText(officialMunicipalityName(contract));
    const matchesIbge = filters.codigoMunicipioIbge && contractIbge === filters.codigoMunicipioIbge;
    const matchesName = requestedCity && contractCity && (contractCity === requestedCity || contractCity.includes(requestedCity));
    return contractUf === filters.uf && (matchesIbge || matchesName);
  }

  return officialSphere(contract) === "F";
}

function contractMatchesFilters(contract, filters) {
  if (!contractMatchesScope(contract, filters)) return false;

  const unidade = contract?.unidadeOrgao || {};
  const orgao = contract?.orgaoEntidade || {};
  const contractText = normalizeText(JSON.stringify(contract));
  const modalidadeId = String(firstValue(contract, ["modalidadeId", "codigoModalidadeContratacao"]) || "");
  const modalidade = `${modalidadeId} ${firstValue(contract, ["modalidadeNome"]) || ""}`;
  const instrumento = `${firstValue(contract, ["tipoInstrumentoConvocatorioCodigo"]) || ""} ${firstValue(contract, ["tipoInstrumentoConvocatorioNome"]) || ""}`;
  const year = String(firstValue(contract, ["anoCompra", "anoContratacao", "ano"]) || "");
  const municipio = `${officialMunicipalityName(contract)} ${officialMunicipalityCode(contract)}`;
  const esfera = `${officialSphere(contract)} ${firstValue(orgao, ["esferaNome", "esfera"]) || ""}`;
  const poder = `${officialPower(contract)} ${firstValue(orgao, ["poderNome", "poder"]) || ""}`;
  const fonte = JSON.stringify(firstValue(contract, ["fontesOrcamentarias", "fonteSistema", "sistemaOrigem", "urlSistemaOrigem"]) || "");
  const emenda = booleanValue(firstValue(contract, ["emendaParlamentar", "possuiEmendaParlamentar"]));

  if (hasFilterValue(filters.palavraChave) && !contractText.includes(normalizeText(filters.palavraChave))) return false;
  if (hasFilterValue(filters.anoContratacao) && year !== filters.anoContratacao) return false;
  if (!matchesTextFilter(instrumento, filters.tipoInstrumentoConvocatorio)) return false;
  if (hasFilterValue(filters.modalidade) && filters.modalidade !== "todos" && modalidadeId !== filters.modalidade && !matchesTextFilter(modalidade, filters.modalidade)) return false;
  if (!matchesTextFilter(`${firstValue(orgao, ["razaoSocial", "nome", "nomeOrgao"]) || ""} ${firstValue(orgao, ["cnpj"]) || ""}`, filters.orgao)) return false;
  if (!matchesTextFilter(`${firstValue(unidade, ["nome", "nomeUnidade", "codigoUnidade", "codigoUnidadeAdministrativa"]) || ""}`, filters.unidade)) return false;
  if (!matchesTextFilter(municipio, filters.cidade || filters.codigoMunicipioIbge)) return false;
  if (hasFilterValue(filters.esfera) && sphereCode(filters.esfera) !== officialSphere(contract)) return false;
  if (hasFilterValue(filters.poder) && powerCode(filters.poder) !== officialPower(contract)) return false;
  if (!matchesTextFilter(fonte, filters.fonte)) return false;
  if (hasFilterValue(filters.emendaParlamentar) && booleanValue(filters.emendaParlamentar) !== emenda) return false;
  if (!matchesTextFilter(contractText, filters.normativoBase)) return false;
  if (!matchesTextFilter(contractText, filters.amparoLegal)) return false;
  if (hasFilterValue(filters.modoDisputa) && String(firstValue(contract, ["modoDisputaId", "codigoModoDisputa"]) || "") !== filters.modoDisputa && !matchesTextFilter(String(firstValue(contract, ["modoDisputaNome"]) || ""), filters.modoDisputa)) return false;
  return true;
}

function itemMatchesFilters(item, contract, filters) {
  const itemText = normalizeText(JSON.stringify(item));
  if (hasFilterValue(filters.criterioJulgamento) && !itemText.includes(normalizeText(filters.criterioJulgamento))) return false;

  const itemSigiloso = booleanValue(firstValue(item, ["orcamentoSigiloso", "itemSigiloso", "possuiItemSigiloso"]));
  if (hasFilterValue(filters.itemSigiloso) && itemSigiloso !== booleanValue(filters.itemSigiloso)) return false;

  const notaFiscal = booleanValue(firstValue(item, ["notaFiscalEletronica", "possuiNotaFiscalEletronica"]) || firstValue(contract, ["notaFiscalEletronica", "possuiNotaFiscalEletronica"]));
  if (hasFilterValue(filters.notaFiscalEletronica) && notaFiscal !== booleanValue(filters.notaFiscalEletronica)) return false;
  return true;
}

function toLead(contract, identity, item, result, history) {
  const supplierName = String(firstValue(result, ["nomeRazaoSocialFornecedor", "razaoSocialFornecedor", "nomeFornecedor"]) || "Fornecedor não informado").trim();
  const supplierId = String(firstValue(result, ["niFornecedor", "cnpjFornecedor", "cpfFornecedor"]) || "").trim();
  const classification = resultClassification(result);
  const procurementId = String(firstValue(contract, ["numeroControlePNCP", "numeroControle", "id"]) || `${identity.cnpj}-${identity.ano}-${identity.sequencial}`);
  const numeroItem = String(firstValue(item, ["numeroItem", "itemNumero", "numero"]) || "");
  const occurrence = buildOccurrence(result, history);

  return {
    id: `${procurementId}:${numeroItem}:${supplierId || supplierName}`,
    fornecedor: supplierName,
    cnpj: supplierId,
    classificacao: classification,
    situacao: resultStatus(result) || (classification && classification > 1 ? `Não vencedor — ${ordinal(classification)} lugar` : "Não vencedor"),
    ocorrencia: occurrence,
    resumoIA: "",
    objeto: contractTitle(contract, item),
    numeroItem,
    numeroControlePNCP: procurementId,
    orgao: String(firstValue(contract?.orgaoEntidade || contract?.orgao || {}, ["razaoSocial", "nome", "nomeOrgao"]) || "Órgão público não informado"),
    uf: String(firstValue(contract?.unidadeOrgao || {}, ["ufSigla", "uf"]) || firstValue(contract, ["uf", "unidadeFederativa"]) || "").toUpperCase(),
    cidade: String(firstValue(contract?.unidadeOrgao || {}, ["municipioNome", "municipio", "nomeMunicipio"]) || ""),
    esfera: String(firstValue(contract?.orgaoEntidade || {}, ["esferaNome", "esferaId", "esfera"]) || ""),
    dataPublicacao: firstValue(contract, ["dataPublicacaoPncp", "dataAtualizacaoGlobal", "dataPublicacao", "dataInclusao"]),
    linkPNCP: firstValue(contract, ["urlSistemaOrigem", "linkSistemaOrigem", "urlPncp", "linkPncp"]) || `https://pncp.gov.br/app/editais/${encodeURIComponent(procurementId)}`
  };
}

function fallbackSummary(lead) {
  if (/inabilitad|desclassificad|eliminad|rejeitad|inapt|cancelad/i.test(lead.ocorrencia)) {
    return `Perdeu porque foi ${lead.ocorrencia.replace(/[.!?]+$/, "").toLocaleLowerCase("pt-BR")}.`;
  }
  if (lead.classificacao && lead.classificacao > 1) {
    return `Não venceu porque ficou em ${ordinal(lead.classificacao)} lugar na classificação do item.`;
  }
  return "Não venceu o item conforme a ocorrência registrada no PNCP.";
}

function purchaseHasResultOrIsFinished(contract) {
  const hasResultFlag = booleanValue(firstValue(contract, ["existeResultado", "temResultado", "temResultados", "possuiResultado"]));
  const homologatedValue = Number(firstValue(contract, ["valorTotalHomologado", "valorHomologado"]));

  if (hasResultFlag === false) return false;
  if (hasResultFlag === true || homologatedValue > 0) return true;

  // As listagens públicas nem sempre trazem existeResultado. Se o encerramento
  // da proposta ainda está no futuro, a contratação não pode gerar fornecedor
  // não vencedor; isso evita centenas de chamadas inúteis no escopo federal.
  const closing = Date.parse(String(firstValue(contract, ["dataEncerramentoProposta"]) || ""));
  return !Number.isFinite(closing) || closing <= Date.now();
}

async function summarizeWithNvidia(lead) {
  if (!NVIDIA_API_KEY) {
    if (!nvidiaSkippedLogged) {
      console.warn("[NVIDIA] resumo ignorado: NVIDIA_API_KEY não configurada; usando fallback local.");
      nvidiaSkippedLogged = true;
    }
    return fallbackSummary(lead);
  }

  const startedAt = Date.now();
  console.log(`[NVIDIA] iniciando resumo lead=${lead.id} modelo=${NVIDIA_MODEL}`);

  const prompt = [
    "Resuma em uma única frase, em português do Brasil, por que o fornecedor não venceu a licitação.",
    "Se houver apenas classificação, diga a colocação. Não invente fatos, não use listas e não comece com rótulos.",
    `Fornecedor: ${lead.fornecedor}`,
    `Objeto: ${lead.objeto}`,
    `Ocorrência registrada: ${lead.ocorrencia}`,
    `Classificação: ${lead.classificacao ? ordinal(lead.classificacao) : "não informada"}`
  ].join("\n");

  try {
    const { status, body } = await request(NVIDIA_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          { role: "system", content: "Você é um analista objetivo de resultados de licitações." },
          { role: "user", content: prompt }
        ]
      })
    }, 30000);

    const content = body?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn(`[NVIDIA] resposta sem conteúdo lead=${lead.id} status=${status} ms=${Date.now() - startedAt}; usando fallback local.`);
      return fallbackSummary(lead);
    }
    const summary = String(content).replace(/\s+/g, " ").trim().replace(/^[-•]\s*/, "");
    const normalizedSummary = summary.length > 260 ? `${summary.slice(0, 257).replace(/\s+\S*$/, "")}...` : summary;
    console.log(`[NVIDIA] resumo concluído lead=${lead.id} status=${status} ms=${Date.now() - startedAt}`);
    return normalizedSummary;
  } catch (error) {
    console.warn(`[NVIDIA] falha lead=${lead.id} ms=${Date.now() - startedAt} status=${error.status || "na"}: ${error.message}; usando fallback local.`);
    return fallbackSummary(lead);
  }
}

async function searchPncp(filters) {
  const contracts = [];
  let lastWindowError;
  const ranges = splitDateRange(filters.dataInicial, filters.dataFinal);

  for (const range of ranges) {
    try {
      const { contracts: windowContracts, errors } = await fetchContractsForWindow(filters, range);
      contracts.push(...windowContracts);
      for (const error of errors) {
        console.warn(`Fonte PNCP indisponível (${range.dataInicial} a ${range.dataFinal}):`, error.message);
      }
      if (!windowContracts.length && errors.length) lastWindowError = errors.at(-1);
    } catch (error) {
      lastWindowError = error;
      console.warn(`Janela PNCP indisponível (${range.dataInicial} a ${range.dataFinal}):`, error.message);
    }
  }

  if (!contracts.length && lastWindowError) throw lastWindowError;

  const uniqueContracts = new Map();
  for (const contract of contracts) {
    const key = String(firstValue(contract, ["numeroControlePNCP", "id"]) || JSON.stringify(contract));
    uniqueContracts.set(key, contract);
  }

  const eligibleContracts = [...uniqueContracts.values()]
    .filter((contract) => purchaseHasResultOrIsFinished(contract) && contractMatchesFilters(contract, filters))
    .slice(0, MAX_CONTRATACOES);

  const contractResults = await mapWithConcurrency(eligibleContracts, 3, async (contract) => {
    const identity = getContractIdentity(contract);
    if (!identity) return [];

    try {
      const items = await fetchItems(identity, contract);
      const itemCandidates = items.filter((item) => item && item.temResultado !== false && itemMatchesFilters(item, contract, filters));
      const itemResults = await mapWithConcurrency(itemCandidates, 4, async (item) => {
        try {
          const results = await fetchResults(identity, item);
          return { item, results };
        } catch (error) {
          console.warn(`Resultados do item indisponíveis (${identity.sequencial}/${firstValue(item, ["numeroItem"])}):`, error.message);
          return { item, results: [] };
        }
      });

      if (!contractStatusMatchesWithItems(contract, filters.status, itemCandidates, itemResults)) return [];

      const losingRows = itemResults.flatMap(({ item, results }) => results.filter(isLosingResult).map((result) => ({ item, result })));
      if (!losingRows.length) return [];
      const history = await fetchHistory(identity);
      return losingRows.map(({ item, result }) => toLead(contract, identity, item, result, history));
    } catch (error) {
      console.warn(`Contratação ${identity.sequencial} indisponível:`, error.message);
      return [];
    }
  });

  const unique = new Map();
  for (const lead of contractResults.flat()) unique.set(lead.id, lead);
  return [...unique.values()]
    .filter((lead) => matchesTextFilter(`${lead.fornecedor} ${lead.cnpj}`, filters.fornecedor))
    .slice(0, MAX_LEADS);
}

async function sendToGoogleSheets(filters, leads) {
  const webhook = GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhook) return { sent: false, skipped: true, reason: "GOOGLE_SHEETS_WEBHOOK_URL não configurada" };

  const { status, body } = await request(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "upsert",
      origem: "pecus-consultoria-licitacoes",
      pesquisadoEm: new Date().toISOString(),
      filtros,
      leads
    })
  }, 30000);
  return { sent: true, status, response: body };
}

function telegramText(filters, leads) {
  const localidade = filters.escopo === "federal"
    ? "Federal"
    : filters.escopo === "cidade"
      ? `${filters.cidade || filters.codigoMunicipioIbge} / ${filters.uf}`
      : filters.uf;
  const lines = [
    "PECUS Consultoria em Licitações",
    `Pesquisa: ${localidade} | ${filters.dataInicial} a ${filters.dataFinal}`,
    `Leads encontrados: ${leads.length}`
  ];

  for (const lead of leads.slice(0, 12)) {
    lines.push(`• ${lead.fornecedor} — ${lead.resumoIA || lead.ocorrencia}`);
  }
  if (leads.length > 12) lines.push(`• +${leads.length - 12} leads na planilha/dashboard.`);
  return lines.join("\n");
}

async function sendToTelegram(filters, leads) {
  const token = TELEGRAM_BOT_TOKEN;
  const chatId = TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, skipped: true, reason: "TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID não configurados" };

  const url = makeUrl(TELEGRAM_API_BASE_URL, `/bot${token}/sendMessage`);
  const { status, body } = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: telegramText(filters, leads), disable_web_page_preview: true })
  }, 30000);
  return { sent: true, status, response: body };
}

function extractLeadsFromWebhook(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  return asList(payload, ["leads", "data", "rows", "records", "values"]);
}

app.get("/api/municipios", async (req, res, next) => {
  const uf = String(req.query.uf || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) return res.status(400).json({ ok: false, error: "Informe uma UF válida para carregar os municípios." });
  if (municipalityCache.has(uf)) return res.json({ ok: true, uf, municipios: municipalityCache.get(uf) });

  try {
    const { body } = await request(`${IBGE_API_BASE_URL}/${uf}/municipios`, {}, 30000);
    const municipios = asList(body)
      .map((municipio) => ({ codigo: String(municipio.id || municipio.codigoIbge || municipio.codigo || ""), nome: String(municipio.nome || municipio.municipio || "").trim() }))
      .filter((municipio) => municipio.codigo && municipio.nome)
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    municipalityCache.set(uf, municipios);
    return res.json({ ok: true, uf, municipios });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "pecus-consultoria-licitacoes",
    timestamp: new Date().toISOString(),
    config: {
      pncp: Boolean(PNCP_API_BASE_URL),
      pncpData: Boolean(PNCP_DATA_API_BASE_URL),
      maxSearchDays: MAX_SEARCH_DAYS,
      pncpPublicationFallback: PNCP_PUBLICATION_FALLBACK,
      pncpUpdateFallbackTimeoutMs: PNCP_UPDATE_FALLBACK_TIMEOUT_MS,
      pncpPublicationTimeoutMs: PNCP_PUBLICATION_TIMEOUT_MS,
      pncpMinIntervalMs: PNCP_MIN_INTERVAL_MS,
      pncpRateLimitCooldownMs: PNCP_RATE_LIMIT_COOLDOWN_MS,
      pncpPrimarySource: PNCP_PRIMARY_SOURCE,
      ibge: Boolean(IBGE_API_BASE_URL),
      nvidia: Boolean(NVIDIA_API_KEY),
      googleSheets: Boolean(GOOGLE_SHEETS_WEBHOOK_URL),
      telegram: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
    }
  });
});

app.get("/api/leads", async (_req, res, next) => {
  const webhook = GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhook) {
    return res.json({ ok: true, configured: false, leads: [], message: "Configure GOOGLE_SHEETS_WEBHOOK_URL para carregar leads salvos." });
  }

  try {
    const { body } = await request(webhook, {}, 30000);
    return res.json({ ok: true, configured: true, leads: extractLeadsFromWebhook(body), source: body });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/buscar", async (req, res, next) => {
  try {
    const filters = validateSearchInput(req.body);
    const rawLeads = await searchPncp(filters);
    const leads = await mapWithConcurrency(rawLeads, 4, async (lead) => ({
      ...lead,
      resumoIA: await summarizeWithNvidia(lead)
    }));

    const [sheetsResult, telegramResult] = await Promise.allSettled([
      sendToGoogleSheets(filters, leads),
      sendToTelegram(filters, leads)
    ]);

    const integration = {
      sheets: sheetsResult.status === "fulfilled" ? sheetsResult.value : { sent: false, error: sheetsResult.reason.message },
      telegram: telegramResult.status === "fulfilled" ? telegramResult.value : { sent: false, error: telegramResult.reason.message }
    };

    return res.json({ ok: true, filtros: filters, total: leads.length, leads, integracoes: integration });
  } catch (error) {
    return next(error);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({ ok: false, error: error.message || "Erro interno do servidor." });
});

app.listen(PORT, () => {
  console.log(`PECUS Consultoria em Licitações disponível em http://localhost:${PORT}`);
  console.log(`[NVIDIA] configuração key=${NVIDIA_API_KEY ? "configurada" : "ausente"} modelo=${NVIDIA_MODEL} url=${safeUrlForLog(NVIDIA_API_URL)}`);
});





