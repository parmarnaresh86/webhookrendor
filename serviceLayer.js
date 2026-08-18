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
  const cookie = await getSessionCookie();
  try {
    const res = await axios({
      url: `${SL_BASE}${path}`,
      httpsAgent,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...options
    });
    return res.data;
  } catch (err) {
    if (err.response && err.response.status === 401) {
      sessionCookie = null;
      const freshCookie = await getSessionCookie();
      const res = await axios({
        url: `${SL_BASE}${path}`,
        httpsAgent,
        headers: { Cookie: freshCookie, 'Content-Type': 'application/json' },
        ...options
      });
      return res.data;
    }
    throw err;
  }
}

async function getPendingApprovals() {
  const data = await callServiceLayer('/ApprovalRequests', {
    params: { '$filter': "Status eq 'arsPending'" }
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

// Confirmed via metadata inspection: ApprovalRequests exposes ApprovalRequestDecisions
// with ApproverUserName/ApproverPassword/Status/Remarks fields, which strongly implies
// the decision actions require the approver's SAP credentials. The exact action path
// and body shape below (POST .../Approve or .../Reject) is based on documented SAP
// Service Layer behavior but was NOT live-tested against this server (by request,
// to avoid mutating real pending approval records) - verify against one real request
// before relying on this in production.
const SL_APPROVER_USERNAME = process.env.SL_APPROVER_USERNAME || SL_USERNAME;
const SL_APPROVER_PASSWORD = process.env.SL_APPROVER_PASSWORD || SL_PASSWORD;

async function decideApproval(code, decision, remarks) {
  const action = decision === 'approved' ? 'Approve' : 'Reject';
  return callServiceLayer(`/ApprovalRequests(${code})/${action}`, {
    method: 'POST',
    data: {
      ApproverUserName: SL_APPROVER_USERNAME,
      ApproverPassword: SL_APPROVER_PASSWORD,
      Remarks: remarks || ''
    }
  });
}

module.exports = { getPendingApprovals, getDraftDetail, getApprovalWithDraft, decideApproval };
