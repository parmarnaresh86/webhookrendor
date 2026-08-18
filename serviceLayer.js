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

// UNRESOLVED - see APPROVAL_DECISION_RESEARCH.md for the full investigation.
// POST /ApprovalRequests(code)/Approve|Reject does not exist ("Command Not Found").
// This shape (root-level DraftsService_HandleApprovalRequest with a bare
// {Code, Status, Remarks} body) is the only one that doesn't get rejected as
// invalid, but it also does not actually change the record's status when
// tested live - do not treat this as working. Replace once the correct call
// is confirmed via SAP support/documentation.
async function decideApproval(code, decision, remarks) {
  return callServiceLayer('/DraftsService_HandleApprovalRequest', {
    method: 'POST',
    data: {
      Code: Number(code),
      Status: decision === 'approved' ? 'arsApproved' : 'arsNotApproved',
      Remarks: remarks || ''
    }
  });
}

module.exports = { getPendingApprovals, getDraftDetail, getApprovalWithDraft, decideApproval };
