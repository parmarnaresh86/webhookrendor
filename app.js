// Import Express.js
const express = require('express');
const {
  getItems,
  findSalesOrderByDocNum,
  getSalesOrderPdf,
  createItem,
  getCustomerBalance,
  submitApprovalDecision
} = require('./sap');
const { sendText, sendPdf, sendButtonMenu, sendListMessage } = require('./whatsapp');
const { getPendingApprovals, getDraftDetail, getApprovalWithDraft, decideApproval } = require('./serviceLayer');

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
const GREETING_KEYWORD = /^(hi|hello|hey|menu)$/i;

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

function truncate(str, max) {
  const s = String(str ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function startSoApprovals(from) {
  try {
    const pending = await getPendingApprovals();
    if (!pending.length) {
      await sendText(from, 'No pending approvals right now.');
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
    await sendListMessage(from, `Pending Approvals${suffix}`, 'View Approvals', rows);
  } catch (err) {
    console.error('Failed to fetch pending approvals:', err.message);
    await sendText(from, 'Sorry, could not fetch pending approvals right now. Please try again later.');
  }
}

async function showApprovalDetail(from, code) {
  try {
    const { draft } = await getApprovalWithDraft(code);
    await sendButtonMenu(
      from,
      `Approval Request #${code}\n\n` +
        `Customer: ${draft.CardName || 'N/A'}\n` +
        `Document Date: ${draft.DocDate}\n` +
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
    const detail = err.response?.data?.error?.message?.value || err.response?.data?.message || err.message;
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

  if (GREETING_KEYWORD.test(trimmed)) {
    userState.delete(from);
    await sendMainMenu(from);
    return;
  }

  if (SALES_ORDER_PRINT_KEYWORD.test(trimmed)) {
    await startSalesOrderPrint(from);
    return;
  }

  if (CUSTOMER_BALANCE_KEYWORD.test(trimmed)) {
    await startCustomerBalance(from);
    return;
  }

  if (SO_APPROVALS_KEYWORD.test(trimmed)) {
    await startSoApprovals(from);
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

// Route for POST requests
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).end();

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
