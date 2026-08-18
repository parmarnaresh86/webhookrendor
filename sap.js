const axios = require('axios');

const SAP_API_BASE = process.env.SAP_API_BASE;
const SAP_USERNAME = process.env.SAP_USERNAME;
const SAP_PASSWORD = process.env.SAP_PASSWORD;
const SAP_COMPANY_ID = Number(process.env.SAP_COMPANY_ID);

let cachedToken = null;
let cachedTokenExpiry = 0;

function decodeJwtExpiry(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  return payload.exp * 1000;
}

async function login() {
  const { data } = await axios.post(`${SAP_API_BASE}/api/login`, {
    username: SAP_USERNAME,
    password: SAP_PASSWORD
  });
  return { preAuthToken: data.preAuthToken, userId: data.user.userId };
}

async function selectCompany(preAuthToken, userId) {
  const { data } = await axios.post(
    `${SAP_API_BASE}/api/select-company`,
    { userId, companyId: SAP_COMPANY_ID },
    { headers: { Authorization: `Bearer ${preAuthToken}` } }
  );
  return data.token;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 30_000) {
    return cachedToken;
  }
  const { preAuthToken, userId } = await login();
  const token = await selectCompany(preAuthToken, userId);
  cachedToken = token;
  cachedTokenExpiry = decodeJwtExpiry(token);
  return token;
}

async function callSapApi(path, options = {}) {
  const token = await getAccessToken();
  try {
    const { data } = await axios({
      url: `${SAP_API_BASE}${path}`,
      headers: { Authorization: `Bearer ${token}` },
      ...options
    });
    return data;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      cachedToken = null;
      const freshToken = await getAccessToken();
      const { data } = await axios({
        url: `${SAP_API_BASE}${path}`,
        headers: { Authorization: `Bearer ${freshToken}` },
        ...options
      });
      return data;
    }
    throw err;
  }
}

async function getItems() {
  return callSapApi('/api/items');
}

const SALES_ORDER_DOC_CODE = 'RDR20007';

async function findSalesOrderByDocNum(docNum) {
  const data = await callSapApi('/api/sales-order/list', { params: { docNum, pageSize: 1 } });
  return data.orders && data.orders[0] ? data.orders[0] : null;
}

async function getSalesOrderPdf(order) {
  const data = await callSapApi('/api/document-print/salesOrder/download-pdf', {
    method: 'POST',
    data: {
      docEntry: order.doc_entry,
      docNum: order.doc_num,
      cardCode: order.customer_code,
      docCode: SALES_ORDER_DOC_CODE
    }
  });
  return Buffer.from(data.base64Pdf, 'base64');
}

async function getCustomerBalance(cardCode) {
  return callSapApi(`/api/business-partners/${encodeURIComponent(cardCode)}`);
}

const DEFAULT_ITEMS_GROUP_CODE = 100;

async function createItem(itemCode, itemName) {
  return callSapApi('/api/items/create', {
    method: 'POST',
    data: {
      ItemCode: itemCode,
      ItemName: itemName,
      ItemsGroupCode: DEFAULT_ITEMS_GROUP_CODE
    }
  });
}

async function submitApprovalDecision(draftId, decision, decidedBy) {
  return callSapApi(`/api/approvals/${encodeURIComponent(draftId)}/decision`, {
    method: 'POST',
    data: { decision, decidedBy }
  });
}

module.exports = {
  getItems,
  findSalesOrderByDocNum,
  getSalesOrderPdf,
  createItem,
  getCustomerBalance,
  submitApprovalDecision
};
