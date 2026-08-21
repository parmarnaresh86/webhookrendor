// Import Express.js
const express = require('express');
const cron = require('node-cron');
const axios = require('axios');
const {
  getItems,
  findSalesOrderByDocNum,
  getSalesOrderPdf,
  createItem,
  getCustomerBalance,
  submitApprovalDecision
} = require('./sap');
const { sendText, sendPdf, sendButtonMenu, sendListMessage } = require('./whatsapp');
const {
  getPendingApprovals,
  getDraftDetail,
  getApprovalWithDraft,
  decideApproval,
  findCustomerByEmail,
  createServiceCall,
  getServiceCallsForDate,
  getDocumentsForDate,
  createActivity,
  getItemStockByWarehouse
} = require('./serviceLayer');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Set port and verify_token
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// Route for GET requests
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

const ITEMS_KEYWORD = /^(list items|items)$/i;

function formatItemList(items) {
  const top = items.slice(0, 20);
  const lines = top.map((item, i) => {
    const stock = item.inStock ?? item.InStock ?? 0;
    const uom = item.uomCode || '';
    return `${i + 1}. ${item.itemName || item.itemCode} - Stock: ${stock} ${uom}`.trim();
  });
  const suffix = items.length > 20 ? `\n\n...and ${items.length - 20} more items.` : '';
  return `Item List (showing ${top.length} of ${items.length}):\n\n${lines.join('\n')}${suffix}`;
}

const SALES_ORDER_PRINT_KEYWORD = /^(print sales order|so print)$/i;
const CUSTOMER_BALANCE_KEYWORD = /^(customer balance|balance)$/i;
const SO_APPROVALS_KEYWORD = /^(so approvals|approvals|pending approvals)$/i;
const APPROVAL_MENU_KEYWORD = /^approval$/i;
const SERVICE_CALL_KEYWORD = /^service call$/i;
const TODAY_SERVICE_CALLS_KEYWORD = /^today service calls?$/i;
const TODAY_SALES_ORDER_KEYWORD = /^today('?s)? sales orders?$/i;
const TODAY_PURCHASE_ORDER_KEYWORD = /^today('?s)? purchase orders?$/i;
const TODAY_INVOICE_KEYWORD = /^today('?s)? invoices?$/i;
const ACTIVITY_KEYWORD = /^(activity|create activity)$/i;
const STOCK_KEYWORD = /^stock$/i;
const BILL_PRINT_KEYWORD = /^(print bill|bill print|milkat bill|બિલ)$/i;
const GREETING_KEYWORD = /^(hi|hello|hey|menu)$/i;

const VERO_BACKEND_URL = process.env.VERO_BACKEND_URL || 'https://vero-backend-4bmj.onrender.com';

const MENU_BUTTONS = [
  { id: 'menu_items', title: '📦 Items List' },
  { id: 'menu_so_print', title: '🖨️ SO Print' },
  { id: 'menu_create_item', title: '➕ Create Item' }
];

const SECONDARY_MENU_BUTTONS = [
  { id: 'menu_customer_balance', title: '💰 Customer Balance' },
  { id: 'menu_so_approvals', title: '📋 SO Approvals' }
];

// In-memory per-sender conversation state. Fine for a single-instance deployment;
// would need a shared store (e.g. Redis) if this ever runs with multiple instances.
// state shapes: { step: 'awaiting_so_docnum' }
//               { step: 'awaiting_item_code' }
//               { step: 'awaiting_item_name', itemCode }
const userState = new Map();

async function sendMainMenu(from) {
  // WhatsApp interactive button messages support a max of 3 buttons,
  // so the menu is split across two messages.
  await sendButtonMenu(from, 'Hello! How can I help you today?', MENU_BUTTONS);
  await sendButtonMenu(from, 'More options:', SECONDARY_MENU_BUTTONS);
}

async function handleItemsRequest(from) {
  try {
    const items = await getItems();
    await sendText(from, formatItemList(items));
  } catch (err) {
    console.error('Failed to fetch/send item list:', err.message);
    await sendText(from, 'Sorry, could not fetch the item list right now. Please try again later.');
  }
}

async function handleSalesOrderDocNum(from, docNumRaw) {
  const docNum = Number(docNumRaw.trim());
  if (!Number.isInteger(docNum)) {
    await sendText(from, 'Please enter a valid numeric document number.');
    return;
  }

  try {
    const order = await findSalesOrderByDocNum(docNum);
    if (!order) {
      await sendText(from, `No Sales Order found with document number ${docNum}.`);
      return;
    }
    const pdfBuffer = await getSalesOrderPdf(order);
    await sendPdf(from, pdfBuffer, `sales-order-${docNum}.pdf`);
  } catch (err) {
    console.error('Failed to fetch/send Sales Order PDF:', err.message);
    await sendText(from, 'Sorry, could not generate the Sales Order PDF right now. Please try again later.');
  }
}

async function startSalesOrderPrint(from) {
  userState.set(from, { step: 'awaiting_so_docnum' });
  await sendText(from, 'Please enter the Sales Order document number.');
}

async function handleBillPropertyNo(from, propertyNoRaw) {
  const propertyNo = propertyNoRaw.trim();
  if (!propertyNo) {
    await sendText(from, 'Please enter a valid Milkat No (property number).');
    return;
  }

  try {
    const response = await axios.get(`${VERO_BACKEND_URL}/api/bills/${encodeURIComponent(propertyNo)}.pdf`, {
      responseType: 'arraybuffer',
      validateStatus: () => true
    });
    if (response.status === 404) {
      await sendText(from, `No bill found for Milkat No ${propertyNo}.`);
      return;
    }
    if (response.status !== 200) {
      await sendText(from, 'Sorry, could not fetch the bill right now. Please try again later.');
      return;
    }
    await sendPdf(from, Buffer.from(response.data), `bill-${propertyNo}.pdf`);
  } catch (err) {
    console.error('Failed to fetch/send bill PDF:', err.message);
    await sendText(from, 'Sorry, could not fetch the bill right now. Please try again later.');
  }
}

async function startBillPrint(from) {
  userState.set(from, { step: 'awaiting_bill_property_no' });
  await sendText(from, 'Please enter your Milkat No (property number).');
}

async function startCreateItem(from) {
  userState.set(from, { step: 'awaiting_item_code' });
  await sendText(from, 'Please enter the new Item Code.');
}

async function handleItemCodeStep(from, itemCodeRaw) {
  const itemCode = itemCodeRaw.trim();
  if (!itemCode) {
    await sendText(from, 'Item Code cannot be empty. Please enter the Item Code.');
    return;
  }
  userState.set(from, { step: 'awaiting_item_name', itemCode });
  await sendText(from, 'Please enter the Item Name.');
}

async function handleItemNameStep(from, itemName, itemCode) {
  const trimmedName = itemName.trim();
  if (!trimmedName) {
    await sendText(from, 'Item Name cannot be empty. Please enter the Item Name.');
    return;
  }
  userState.set(from, { step: 'awaiting_item_confirm', itemCode, itemName: trimmedName });
  await sendButtonMenu(
    from,
    `Confirm new item:\nCode: ${itemCode}\nName: ${trimmedName}`,
    [
      { id: 'create_item_save', title: '✅ Save' },
      { id: 'create_item_cancel', title: '❌ Cancel' }
    ]
  );
}

async function startCustomerBalance(from) {
  userState.set(from, { step: 'awaiting_customer_code' });
  await sendText(from, 'Please enter the Customer Code.');
}

async function handleCustomerCodeStep(from, cardCodeRaw) {
  const cardCode = cardCodeRaw.trim();
  if (!cardCode) {
    await sendText(from, 'Customer Code cannot be empty. Please enter the Customer Code.');
    return;
  }

  try {
    const bp = await getCustomerBalance(cardCode);
    const balance = bp.CurrentAccountBalance ?? 0;
    await sendText(
      from,
      `Customer: ${bp.CardName || cardCode}\nCode: ${bp.CardCode || cardCode}\nOutstanding Balance: ${balance}`
    );
  } catch (err) {
    console.error('Failed to fetch customer balance:', err.message);
    const notFound = err.response?.status === 404;
    await sendText(
      from,
      notFound
        ? `No customer found with code ${cardCode}.`
        : 'Sorry, could not fetch the customer balance right now. Please try again later.'
    );
  }
}

const SERVICE_CALL_SUBJECTS = {
  svc_raise_issue: 'Raise Issue',
  svc_book_service: 'Book Call for Service',
  svc_book_visit: 'Book Call for Visit'
};

async function startServiceCall(from) {
  userState.set(from, { step: 'awaiting_service_email' });
  await sendText(from, 'Please enter your Email ID.');
}

async function sendServiceOptionsMenu(from, cardName) {
  await sendButtonMenu(from, `Hello ${cardName}! What can I help you with?`, [
    { id: 'svc_raise_issue', title: '🛠️ Raise Issue' },
    { id: 'svc_book_service', title: '🔧 Service Call' },
    { id: 'svc_book_visit', title: '📍 Book Visit' }
  ]);
}

async function handleServiceEmailStep(from, emailRaw) {
  const email = emailRaw.trim().toLowerCase();
  if (!email) {
    await sendText(from, 'Email ID cannot be empty. Please enter your Email ID.');
    return;
  }

  try {
    const customer = await findCustomerByEmail(email);
    if (!customer) {
      userState.delete(from);
      await sendText(from, `No customer found with email ${email}.`);
      return;
    }

    userState.set(from, {
      step: 'awaiting_service_option',
      cardCode: customer.CardCode,
      cardName: customer.CardName
    });

    await sendServiceOptionsMenu(from, customer.CardName);
  } catch (err) {
    console.error('Failed to look up customer by email:', err.message);
    userState.delete(from);
    await sendText(from, 'Sorry, could not look up that customer right now. Please try again later.');
  }
}

async function handleServiceOptionSelection(from, buttonId) {
  const state = userState.get(from);
  if (state?.step !== 'awaiting_service_option') return;

  const subject = SERVICE_CALL_SUBJECTS[buttonId];
  userState.set(from, { ...state, step: 'awaiting_service_reason', subject });
  await sendText(from, 'Please enter the reason.');
}

async function handleServiceReasonStep(from, reasonRaw, state) {
  const reason = reasonRaw.trim();
  if (!reason) {
    await sendText(from, 'Reason cannot be empty. Please enter the reason.');
    return;
  }

  try {
    const serviceCall = await createServiceCall(state.cardCode, state.subject, reason);
    await sendText(
      from,
      `Service Call created successfully.\n\nDoc No: ${serviceCall.DocNum}\nCustomer: ${state.cardName}\nSubject: ${state.subject}\nReason: ${reason}`
    );
    userState.set(from, { step: 'awaiting_book_another', cardCode: state.cardCode, cardName: state.cardName });
    await sendButtonMenu(from, 'Do you want to book another call?', [
      { id: 'svc_another_yes', title: '✅ Yes' },
      { id: 'svc_another_no', title: '❌ No' }
    ]);
  } catch (err) {
    console.error('Failed to create service call:', err.message);
    const errData = err.response?.data?.error;
    const detail =
      (typeof errData?.message === 'string' ? errData.message : errData?.message?.value) ||
      err.response?.data?.message ||
      err.message;
    await sendText(from, `Sorry, could not create the Service Call. ${detail}`);
  }
}

async function handleBookAnotherSelection(from, wantsAnother) {
  const state = userState.get(from);
  if (state?.step !== 'awaiting_book_another') return;

  if (wantsAnother) {
    userState.set(from, { step: 'awaiting_service_option', cardCode: state.cardCode, cardName: state.cardName });
    await sendServiceOptionsMenu(from, state.cardName);
  } else {
    userState.delete(from);
    await sendText(
      from,
      'Thank you for visiting STTL. Our representative will contact you shortly. Have a great day!'
    );
  }
}

const ACTIVITY_TYPES = {
  act_call: 'cn_Conversation',
  act_meeting: 'cn_Meeting',
  act_task: 'cn_Task'
};

const ACTIVITY_TYPE_LABELS = {
  act_call: 'Call',
  act_meeting: 'Meeting',
  act_task: 'Task'
};

async function startActivityCreation(from) {
  userState.set(from, { step: 'awaiting_activity_email' });
  await sendText(from, 'Please enter your Email ID.');
}

async function handleActivityEmailStep(from, emailRaw) {
  const email = emailRaw.trim().toLowerCase();
  if (!email) {
    await sendText(from, 'Email ID cannot be empty. Please enter your Email ID.');
    return;
  }

  try {
    const customer = await findCustomerByEmail(email);
    if (!customer) {
      userState.delete(from);
      await sendText(from, `No customer found with email ${email}.`);
      return;
    }

    userState.set(from, {
      step: 'awaiting_activity_type',
      cardCode: customer.CardCode,
      cardName: customer.CardName
    });

    await sendButtonMenu(from, `Hello ${customer.CardName}! What type of activity would you like to log?`, [
      { id: 'act_call', title: '📞 Call' },
      { id: 'act_meeting', title: '🤝 Meeting' },
      { id: 'act_task', title: '✅ Task' }
    ]);
  } catch (err) {
    console.error('Failed to look up customer by email:', err.message);
    userState.delete(from);
    await sendText(from, 'Sorry, could not look up that customer right now. Please try again later.');
  }
}

async function handleActivityTypeSelection(from, buttonId) {
  const state = userState.get(from);
  if (state?.step !== 'awaiting_activity_type') return;

  userState.set(from, {
    ...state,
    step: 'awaiting_activity_notes',
    activityType: ACTIVITY_TYPES[buttonId],
    activityLabel: ACTIVITY_TYPE_LABELS[buttonId]
  });
  await sendText(from, 'Please enter the notes.');
}

async function handleActivityNotesStep(from, notesRaw, state) {
  const notes = notesRaw.trim();
  if (!notes) {
    await sendText(from, 'Notes cannot be empty. Please enter the notes.');
    return;
  }

  try {
    const activity = await createActivity(state.cardCode, state.activityType, notes);
    await sendText(
      from,
      `Activity created successfully.\n\nCode: ${activity.ActivityCode}\nCustomer: ${state.cardName}\nType: ${state.activityLabel}\nNotes: ${notes}`
    );
  } catch (err) {
    console.error('Failed to create activity:', err.message);
    const errData = err.response?.data?.error;
    const detail =
      (typeof errData?.message === 'string' ? errData.message : errData?.message?.value) ||
      err.response?.data?.message ||
      err.message;
    await sendText(from, `Sorry, could not create the Activity. ${detail}`);
  }
}

async function startStockLookup(from) {
  userState.set(from, { step: 'awaiting_stock_item_code' });
  await sendText(from, 'Please enter the Item Code.');
}

async function handleStockItemCodeStep(from, itemCodeRaw) {
  const itemCode = itemCodeRaw.trim();
  if (!itemCode) {
    await sendText(from, 'Item Code cannot be empty. Please enter the Item Code.');
    return;
  }

  try {
    const item = await getItemStockByWarehouse(itemCode);
    const warehouses = item.ItemWarehouseInfoCollection || [];
    const withStock = warehouses.filter((w) => w.InStock);
    const lines = (withStock.length ? withStock : warehouses)
      .map((w) => `- ${w.WarehouseCode}: ${w.InStock} (Committed: ${w.Committed}, Ordered: ${w.Ordered})`)
      .join('\n');
    await sendText(
      from,
      `Item: ${item.ItemName || itemCode}\nCode: ${item.ItemCode || itemCode}\n\nStock by Warehouse:\n${lines}`
    );
  } catch (err) {
    console.error('Failed to fetch item stock:', err.message);
    const notFound = err.response?.status === 404;
    await sendText(
      from,
      notFound
        ? `No item found with code ${itemCode}.`
        : 'Sorry, could not fetch item stock right now. Please try again later.'
    );
  }
}

// SAP B1's standard Service Call status codes (not a named OData enum in
// the metadata, just Edm.Int32) - confirmed -3 = Open from live data.
// Other codes shown as-is if encountered.
const SERVICE_CALL_STATUS_LABELS = {
  '-3': 'Open',
  '-2': 'On Hold',
  '-1': 'Closed'
};

function formatServiceCallStatus(status) {
  return SERVICE_CALL_STATUS_LABELS[String(status)] || `Status code ${status}`;
}

function formatServiceCallsSummary(calls, dateLabel) {
  if (!calls.length) {
    return `No Service Calls found for ${dateLabel}.`;
  }
  const lines = calls.map(
    (call) =>
      `Doc No: ${call.DocNum}\nCustomer: ${call.CustomerName}\nSubject: ${call.Subject}\n` +
      `Status: ${formatServiceCallStatus(call.Status)}\nDetail: ${call.Description || 'N/A'}`
  );
  return `Service Calls for ${dateLabel} (${calls.length}):\n\n${lines.join('\n\n')}`;
}

const TEST_NOTIFY_PHONE = process.env.TEST_NOTIFY_PHONE || '917801829449';

async function sendTodaysServiceCallsSummary(toNumber) {
  try {
    const calls = await getServiceCallsForDate(new Date());
    const dateLabel = new Date().toISOString().slice(0, 10);
    await sendText(toNumber, formatServiceCallsSummary(calls, dateLabel));
  } catch (err) {
    console.error('Failed to send today\'s service calls summary:', err.message);
    await sendText(toNumber, 'Sorry, could not fetch today\'s Service Calls right now.');
  }
}

// Runs once a day; server clock is UTC on Render, so this fires at 09:00 UTC.
// Adjust the cron expression if a different local time is needed.
cron.schedule('0 9 * * *', () => {
  sendTodaysServiceCallsSummary(TEST_NOTIFY_PHONE).catch((err) =>
    console.error('Scheduled service call summary failed:', err.message)
  );
});

const DOCUMENT_STATUS_LABELS = {
  bost_Open: 'Open',
  bost_Close: 'Closed'
};

function formatDocumentStatus(status) {
  return DOCUMENT_STATUS_LABELS[status] || status;
}

const TODAY_DOCUMENT_TYPES = {
  so: { entitySet: 'Orders', label: 'Sales Order' },
  po: { entitySet: 'PurchaseOrders', label: 'Purchase Order' },
  invoice: { entitySet: 'Invoices', label: 'Invoice' }
};

function formatDocumentsSummary(docs, label, dateLabel) {
  if (!docs.length) {
    return `No ${label}s found for ${dateLabel}.`;
  }
  const lines = docs.map(
    (doc) =>
      `Doc No: ${doc.DocNum}\nCustomer: ${doc.CardName}\nTotal: ${doc.DocTotal}\n` +
      `Status: ${formatDocumentStatus(doc.DocumentStatus)}`
  );
  return `${label}s for ${dateLabel} (${docs.length}):\n\n${lines.join('\n\n')}`;
}

async function sendTodaysDocumentsSummary(from, docTypeKey) {
  const docType = TODAY_DOCUMENT_TYPES[docTypeKey];
  try {
    const docs = await getDocumentsForDate(docType.entitySet, new Date());
    const dateLabel = new Date().toISOString().slice(0, 10);
    await sendText(from, formatDocumentsSummary(docs, docType.label, dateLabel));
  } catch (err) {
    console.error(`Failed to fetch today's ${docType.label}s:`, err.message);
    await sendText(from, `Sorry, could not fetch today's ${docType.label}s right now.`);
  }
}

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// SAP B1 object type codes: 17 = Sales Order, 22 = Purchase Order,
// 13 = A/R Invoice.
const APPROVAL_DOC_TYPES = {
  so: { objectType: '17', label: 'Sales Order' },
  po: { objectType: '22', label: 'Purchase Order' },
  invoice: { objectType: '13', label: 'Invoice' }
};

async function startApprovalsList(from, docTypeKey) {
  const docType = APPROVAL_DOC_TYPES[docTypeKey];
  try {
    const pending = await getPendingApprovals(docType.objectType);
    if (!pending.length) {
      await sendText(from, `No pending ${docType.label} approvals right now.`);
      return;
    }

    const top = pending.slice(0, 10);
    const rows = await Promise.all(
      top.map(async (approval) => {
        try {
          const draft = await getDraftDetail(approval.DraftEntry);
          return {
            id: `sl_approval_${approval.Code}`,
            title: truncate(draft.CardName || `Draft ${approval.DraftEntry}`, 24),
            description: truncate(`Total: ${draft.DocTotal}`, 72)
          };
        } catch (err) {
          return {
            id: `sl_approval_${approval.Code}`,
            title: truncate(`Draft ${approval.DraftEntry}`, 24),
            description: 'Details unavailable'
          };
        }
      })
    );

    const suffix = pending.length > 10 ? ` (showing 10 of ${pending.length})` : '';
    await sendListMessage(from, `Pending ${docType.label} Approvals${suffix}`, 'View Approvals', rows);
  } catch (err) {
    console.error(`Failed to fetch pending ${docType.label} approvals:`, err.message);
    await sendText(from, 'Sorry, could not fetch pending approvals right now. Please try again later.');
  }
}

async function startSoApprovals(from) {
  await startApprovalsList(from, 'so');
}

async function sendApprovalTypeMenu(from) {
  await sendButtonMenu(from, 'Welcome to SAP B1 Approval System', [
    { id: 'apptype_so', title: '📄 SO Approval' },
    { id: 'apptype_po', title: '📦 PO Approval' },
    { id: 'apptype_invoice', title: '🧾 Invoice Approval' }
  ]);
}

function formatDraftLines(draft) {
  const lines = draft.DocumentLines || [];
  const top = lines.slice(0, 15);
  const formatted = top.map(
    (line) =>
      `- ${line.ItemDescription || line.ItemCode} | Qty: ${line.Quantity} | Price: ${line.Price} | Total: ${line.LineTotal}`
  );
  const suffix = lines.length > 15 ? `\n...and ${lines.length - 15} more line(s).` : '';
  return `${formatted.join('\n')}${suffix}`;
}

async function showApprovalDetail(from, code) {
  try {
    const { draft } = await getApprovalWithDraft(code);
    await sendButtonMenu(
      from,
      `Approval Request #${code}\n\n` +
        `Customer: ${draft.CardName || 'N/A'}\n` +
        `Document Date: ${draft.DocDate}\n\n` +
        `${formatDraftLines(draft)}\n\n` +
        `Total Amount: ${draft.DocTotal}`,
      [
        { id: `sl_decide_approve_${code}`, title: '✅ Approve' },
        { id: `sl_decide_reject_${code}`, title: '❌ Reject' }
      ]
    );
  } catch (err) {
    console.error('Failed to fetch approval detail:', err.message);
    await sendText(from, `Sorry, could not load details for approval #${code}. Please try again later.`);
  }
}

async function handleSoApprovalDecision(from, code, decision) {
  try {
    await decideApproval(code, decision, `Decided via WhatsApp by ${from}`);
    await sendText(from, `Approval #${code} has been ${decision}.`);
  } catch (err) {
    console.error('Failed to submit SL approval decision:', err.message);
    const errData = err.response?.data?.error;
    const detail =
      (typeof errData?.message === 'string' ? errData.message : errData?.message?.value) ||
      err.response?.data?.message ||
      err.message;
    await sendText(from, `Sorry, could not record your decision for approval #${code}. ${detail}`);
  }
}

async function saveNewItem(from, itemCode, itemName) {
  try {
    await createItem(itemCode, itemName);
    await sendText(from, `Item created successfully:\nCode: ${itemCode}\nName: ${itemName}`);
  } catch (err) {
    console.error('Failed to create item:', err.message);
    const detail = err.response?.data?.message || err.message;
    await sendText(from, `Sorry, could not create the item. ${detail}`);
  }
}

async function handleIncomingText(from, text) {
  const trimmed = text.trim();
  const state = userState.get(from);

  if (state?.step === 'awaiting_so_docnum') {
    userState.delete(from);
    await handleSalesOrderDocNum(from, trimmed);
    return;
  }

  if (state?.step === 'awaiting_bill_property_no') {
    userState.delete(from);
    await handleBillPropertyNo(from, trimmed);
    return;
  }

  if (state?.step === 'awaiting_item_code') {
    await handleItemCodeStep(from, trimmed);
    return;
  }

  if (state?.step === 'awaiting_item_name') {
    await handleItemNameStep(from, trimmed, state.itemCode);
    return;
  }

  if (state?.step === 'awaiting_customer_code') {
    userState.delete(from);
    await handleCustomerCodeStep(from, trimmed);
    return;
  }

  if (state?.step === 'awaiting_service_email') {
    await handleServiceEmailStep(from, trimmed);
    return;
  }

  if (state?.step === 'awaiting_service_reason') {
    userState.delete(from);
    await handleServiceReasonStep(from, trimmed, state);
    return;
  }

  if (state?.step === 'awaiting_activity_email') {
    await handleActivityEmailStep(from, trimmed);
    return;
  }

  if (state?.step === 'awaiting_activity_notes') {
    userState.delete(from);
    await handleActivityNotesStep(from, trimmed, state);
    return;
  }

  if (state?.step === 'awaiting_stock_item_code') {
    userState.delete(from);
    await handleStockItemCodeStep(from, trimmed);
    return;
  }

  if (GREETING_KEYWORD.test(trimmed)) {
    userState.delete(from);
    await sendMainMenu(from);
    return;
  }

  if (SALES_ORDER_PRINT_KEYWORD.test(trimmed)) {
    await startSalesOrderPrint(from);
    return;
  }

  if (BILL_PRINT_KEYWORD.test(trimmed)) {
    await startBillPrint(from);
    return;
  }

  if (CUSTOMER_BALANCE_KEYWORD.test(trimmed)) {
    await startCustomerBalance(from);
    return;
  }

  if (APPROVAL_MENU_KEYWORD.test(trimmed)) {
    await sendApprovalTypeMenu(from);
    return;
  }

  if (SO_APPROVALS_KEYWORD.test(trimmed)) {
    await startSoApprovals(from);
    return;
  }

  if (SERVICE_CALL_KEYWORD.test(trimmed)) {
    await startServiceCall(from);
    return;
  }

  if (TODAY_SERVICE_CALLS_KEYWORD.test(trimmed)) {
    await sendTodaysServiceCallsSummary(TEST_NOTIFY_PHONE);
    if (from !== TEST_NOTIFY_PHONE) {
      await sendText(from, `Sent today's Service Call summary to +${TEST_NOTIFY_PHONE}.`);
    }
    return;
  }

  if (TODAY_SALES_ORDER_KEYWORD.test(trimmed)) {
    await sendTodaysDocumentsSummary(from, 'so');
    return;
  }

  if (TODAY_PURCHASE_ORDER_KEYWORD.test(trimmed)) {
    await sendTodaysDocumentsSummary(from, 'po');
    return;
  }

  if (TODAY_INVOICE_KEYWORD.test(trimmed)) {
    await sendTodaysDocumentsSummary(from, 'invoice');
    return;
  }

  if (ACTIVITY_KEYWORD.test(trimmed)) {
    await startActivityCreation(from);
    return;
  }

  if (STOCK_KEYWORD.test(trimmed)) {
    await startStockLookup(from);
    return;
  }

  if (ITEMS_KEYWORD.test(trimmed)) {
    await handleItemsRequest(from);
  }
}

async function handleButtonReply(from, buttonId) {
  if (buttonId === 'menu_items') {
    await handleItemsRequest(from);
  } else if (buttonId === 'menu_so_print') {
    await startSalesOrderPrint(from);
  } else if (buttonId === 'menu_create_item') {
    await startCreateItem(from);
  } else if (buttonId === 'menu_customer_balance') {
    await startCustomerBalance(from);
  } else if (buttonId === 'menu_so_approvals') {
    await startSoApprovals(from);
  } else if (buttonId === 'apptype_so') {
    await startApprovalsList(from, 'so');
  } else if (buttonId === 'apptype_po') {
    await startApprovalsList(from, 'po');
  } else if (buttonId === 'apptype_invoice') {
    await startApprovalsList(from, 'invoice');
  } else if (buttonId === 'create_item_save') {
    const state = userState.get(from);
    userState.delete(from);
    if (state?.step === 'awaiting_item_confirm') {
      await saveNewItem(from, state.itemCode, state.itemName);
    }
  } else if (buttonId === 'create_item_cancel') {
    userState.delete(from);
    await sendText(from, 'Item creation cancelled.');
  } else if (buttonId.startsWith('approve_')) {
    await handleApprovalDecision(from, buttonId.slice('approve_'.length), 'approved');
  } else if (buttonId.startsWith('reject_')) {
    await handleApprovalDecision(from, buttonId.slice('reject_'.length), 'rejected');
  } else if (buttonId.startsWith('sl_decide_approve_')) {
    await handleSoApprovalDecision(from, buttonId.slice('sl_decide_approve_'.length), 'approved');
  } else if (buttonId.startsWith('sl_decide_reject_')) {
    await handleSoApprovalDecision(from, buttonId.slice('sl_decide_reject_'.length), 'rejected');
  } else if (Object.prototype.hasOwnProperty.call(SERVICE_CALL_SUBJECTS, buttonId)) {
    await handleServiceOptionSelection(from, buttonId);
  } else if (buttonId === 'svc_another_yes') {
    await handleBookAnotherSelection(from, true);
  } else if (buttonId === 'svc_another_no') {
    await handleBookAnotherSelection(from, false);
  } else if (Object.prototype.hasOwnProperty.call(ACTIVITY_TYPES, buttonId)) {
    await handleActivityTypeSelection(from, buttonId);
  }
}

async function handleListReply(from, listItemId) {
  if (listItemId.startsWith('sl_approval_')) {
    await showApprovalDetail(from, listItemId.slice('sl_approval_'.length));
  }
}

function formatApprovalMessage({ documentType, customerName, items, grandTotal }) {
  const lines = (items || []).map(
    (item) => `- ${item.itemName} | Qty: ${item.quantity} | Price: ${item.price} | Total: ${item.total}`
  );
  return (
    `New ${documentType || 'Document'} Approval Request\n\n` +
    `Customer: ${customerName}\n\n` +
    `${lines.join('\n')}\n\n` +
    `Grand Total: ${grandTotal}\n\n` +
    `Please approve or reject:`
  );
}

// Called by the SAP backend when a draft document enters approval status.
// Protected by a shared secret so random requests can't trigger fake
// approval messages to real approvers.
app.post('/notify-approval', (req, res) => {
  const providedSecret = req.headers['x-internal-token'];
  if (!process.env.APPROVAL_NOTIFY_SECRET || providedSecret !== process.env.APPROVAL_NOTIFY_SECRET) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  const { approverPhone, draftId, documentType, customerName, items, grandTotal } = req.body || {};
  if (!approverPhone || !draftId) {
    res.status(400).json({ success: false, message: 'approverPhone and draftId are required' });
    return;
  }

  res.status(200).json({ success: true });

  sendButtonMenu(approverPhone, formatApprovalMessage({ documentType, customerName, items, grandTotal }), [
    { id: `approve_${draftId}`, title: '✅ Approve' },
    { id: `reject_${draftId}`, title: '❌ Reject' }
  ]).catch((err) => console.error('Failed to send approval notification:', err.message));
});

async function handleApprovalDecision(from, draftId, decision) {
  try {
    await submitApprovalDecision(draftId, decision, `whatsapp:${from}`);
    await sendText(from, `Document ${draftId} has been ${decision}.`);
  } catch (err) {
    console.error('Failed to submit approval decision:', err.message);
    const detail = err.response?.data?.message || err.message;
    await sendText(from, `Sorry, could not record your decision for document ${draftId}. ${detail}`);
  }
}

// This phone number is shared with the vero billing project, which also
// wants delivery/read/failed status callbacks - but Meta only allows one
// registered webhook per app/number. Since this webhook is the one
// registered with Meta, forward the raw payload to vero's own webhook
// endpoint (which parses the same Meta payload shape) rather than
// duplicating the registration.
const VERO_WEBHOOK_FORWARD_URL = process.env.VERO_WEBHOOK_FORWARD_URL || 'https://vero-backend-4bmj.onrender.com/api/webhook/whatsapp';

function forwardWebhookToVero(body) {
  if (!VERO_WEBHOOK_FORWARD_URL) return;
  axios.post(VERO_WEBHOOK_FORWARD_URL, body, { timeout: 5000 }).catch((err) =>
    console.error('Failed to forward webhook to vero:', err.message)
  );
}

// Route for POST requests
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).end();

  forwardWebhookToVero(req.body);

  const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
  if (messages && messages.length) {
    for (const message of messages) {
      if (message.type === 'text') {
        handleIncomingText(message.from, message.text.body).catch((err) =>
          console.error('Error handling message:', err.message)
        );
      } else if (message.type === 'interactive' && message.interactive?.type === 'button_reply') {
        handleButtonReply(message.from, message.interactive.button_reply.id).catch((err) =>
          console.error('Error handling button reply:', err.message)
        );
      } else if (message.type === 'interactive' && message.interactive?.type === 'list_reply') {
        handleListReply(message.from, message.interactive.list_reply.id).catch((err) =>
          console.error('Error handling list reply:', err.message)
        );
      }
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
