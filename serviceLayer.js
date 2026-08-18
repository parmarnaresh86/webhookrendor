const axios = require('axios');
const https = require('https');

const SL_BASE = process.env.SL_BASE; // e.g. https://silverdemo.silvertouch.com:50000/b1s/v1
const SL_COMPANY_DB = process.env.SL_COMPANY_DB;
const SL_USERNAME = process.env.SL_USERNAME;
const SL_PASSWORD = process.env.SL_PASSWORD;

// The demo server uses a self-signed certificate (confirmed working only
// with curl -k during testing). Replace with proper CA validation if this
// ever points at a server with a valid certificate.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

let sessionCookie = null;
let sessionExpiry = 0;

async function login() {
  const res = await axios.post(
    `${SL_BASE}/Login`,
    { CompanyDB: SL_COMPANY_DB, UserName: SL_USERNAME, Password: SL_PASSWORD },
    { httpsAgent }
  );
  const setCookies = res.headers['set-cookie'] || [];
  sessionCookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  // SessionTimeout is in minutes (confirmed 30 on this server); refresh a bit early.
  sessionExpiry = Date.now() + (Math.max(res.data.SessionTimeout - 2, 1)) * 60 * 1000;
}

async function getSessionCookie() {
  if (!sessionCookie || Date.now() > sessionExpiry) {
    await login();
  }
  return sessionCookie;
}

async function callServiceLayer(path, options = {}) {
  const { baseUrl = SL_BASE, ...axiosOptions } = options;
  const cookie = await getSessionCookie();
  try {
    const res = await axios({
      url: `${baseUrl}${path}`,
      httpsAgent,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...axiosOptions
    });
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      sessionCookie = null;
      const freshCookie = await getSessionCookie();
      const res = await axios({
        url: `${baseUrl}${path}`,
        httpsAgent,
        headers: { Cookie: freshCookie, 'Content-Type': 'application/json' },
        ...axiosOptions
      });
      return res.data;
    }
    throw err;
  }
}

// SL_BASE is configured as the v1 endpoint; the confirmed-working approval
// decision call requires v2. Session cookies are shared across versions on
// the same server, so the same login/session logic still applies.
const SL_BASE_V2 = SL_BASE.replace(/\/v1$/, '/v2');

// SAP B1 object type codes: 17 = Sales Order (Orders), 22 = Purchase Order,
// 1470000113 = Purchase Request. Filtering by ObjectType keeps unrelated
// document types (which can vastly outnumber Sales Orders in a live system)
// from crowding out the ones we actually want to show.
const SALES_ORDER_OBJECT_TYPE = '17';

async function getPendingApprovals(objectType = SALES_ORDER_OBJECT_TYPE) {
  const data = await callServiceLayer('/ApprovalRequests', {
    params: {
      '$filter': `Status eq 'arsPending' and ObjectType eq '${objectType}'`,
      '$orderby': 'Code desc'
    }
  });
  return data.value || [];
}

async function getDraftDetail(draftEntry) {
  return callServiceLayer(`/Drafts(${draftEntry})`);
}

async function getApprovalWithDraft(code) {
  const approval = await callServiceLayer(`/ApprovalRequests(${code})`);
  const draft = await getDraftDetail(approval.DraftEntry);
  return { approval, draft };
}

// Confirmed working via live test against ApprovalRequests(10) on
// WMS_DEV_UK: PATCH on the entity itself (v2 endpoint) with just the
// ApprovalRequestDecisions array - no ApproverUserName/Password or
// StageCode/UserID needed, the session's identity handles that. This
// flipped Code 10 from arsPending to arsNotApproved and updated the
// matching ApprovalRequestLines entry. See APPROVAL_DECISION_RESEARCH.md
// for the full trail of what was tried before landing on this.
async function decideApproval(code, decision, remarks) {
  return callServiceLayer(`/ApprovalRequests(${code})`, {
    baseUrl: SL_BASE_V2,
    method: 'PATCH',
    data: {
      ApprovalRequestDecisions: [
        {
          Status: decision === 'approved' ? 'ardApproved' : 'ardNotApproved',
          Remarks: remarks || ''
        }
      ]
    }
  });
}

// Caller lowercases the input email before calling this (app.js). Service
// Layer's OData filter here does an exact string match with no tolower()
// support, so this assumes EmailAddress is stored lowercase in SAP - true
// for the data checked so far (e.g. naresh.parmar@silvertouch.com).
async function findCustomerByEmail(email) {
  const escaped = email.replace(/'/g, "''");
  const data = await callServiceLayer('/BusinessPartners', {
    baseUrl: SL_BASE_V2,
    params: {
      '$filter': `CardType eq 'cCustomer' and EmailAddress eq '${escaped}'`,
      '$select': 'CardCode,CardName,EmailAddress'
    }
  });
  return data.value && data.value[0] ? data.value[0] : null;
}

// Confirmed working via live test: POST /ServiceCalls with just
// CustomerCode/Subject/Description creates a real Service Call
// (verified: ServiceCallID 245, DocNum 88, for CardCode 1000).
async function createServiceCall(cardCode, subject, description) {
  return callServiceLayer('/ServiceCalls', {
    baseUrl: SL_BASE_V2,
    method: 'POST',
    data: {
      CustomerCode: cardCode,
      Subject: subject,
      Description: description
    }
  });
}

// Confirmed working live: unquoted ISO date filter, e.g.
// "CreationDate eq 2026-08-18T00:00:00Z", matches CreationDate exactly
// (SAP stores it as a date-only value at midnight).
async function getServiceCallsForDate(date) {
  const isoDate = date.toISOString().slice(0, 10);
  const data = await callServiceLayer('/ServiceCalls', {
    baseUrl: SL_BASE_V2,
    params: {
      '$filter': `CreationDate eq ${isoDate}T00:00:00Z`,
      '$select': 'ServiceCallID,DocNum,Subject,CustomerName,Status,Description'
    }
  });
  return data.value || [];
}

// Confirmed working live against Orders, PurchaseOrders, and Invoices - same
// field names and CreationDate filter pattern as getServiceCallsForDate.
async function getDocumentsForDate(entitySet, date) {
  const isoDate = date.toISOString().slice(0, 10);
  const data = await callServiceLayer(`/${entitySet}`, {
    baseUrl: SL_BASE_V2,
    params: {
      '$filter': `CreationDate eq ${isoDate}T00:00:00Z`,
      '$select': 'DocEntry,DocNum,CardName,DocTotal,DocumentStatus'
    }
  });
  return data.value || [];
}

// Confirmed working via live test: POST /Activities with just
// CardCode/Activity/Notes creates a real Activity
// (verified: ActivityCode 81 for CardCode 1000).
async function createActivity(cardCode, activityType, notes) {
  return callServiceLayer('/Activities', {
    baseUrl: SL_BASE_V2,
    method: 'POST',
    data: {
      CardCode: cardCode,
      Activity: activityType,
      Notes: notes
    }
  });
}

module.exports = {
  getPendingApprovals,
  getDraftDetail,
  getApprovalWithDraft,
  decideApproval,
  findCustomerByEmail,
  createServiceCall,
  getServiceCallsForDate,
  getDocumentsForDate,
  createActivity
};
