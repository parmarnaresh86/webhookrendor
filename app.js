// Import Express.js
const express = require('express');
const { getItems, findSalesOrderByDocNum, getSalesOrderPdf, createItem } = require('./sap');
const { sendText, sendPdf, sendButtonMenu } = require('./whatsapp');

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
const GREETING_KEYWORD = /^(hi|hello|hey|menu)$/i;

const MENU_BUTTONS = [
  { id: 'menu_items', title: '📦 Items List' },
  { id: 'menu_so_print', title: '🖨️ SO Print' },
  { id: 'menu_create_item', title: '➕ Create Item' }
];

// In-memory per-sender conversation state. Fine for a single-instance deployment;
// would need a shared store (e.g. Redis) if this ever runs with multiple instances.
// state shapes: { step: 'awaiting_so_docnum' }
//               { step: 'awaiting_item_code' }
//               { step: 'awaiting_item_name', itemCode }
const userState = new Map();

async function sendMainMenu(from) {
  await sendButtonMenu(from, 'Hello! How can I help you today?', MENU_BUTTONS);
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

  if (GREETING_KEYWORD.test(trimmed)) {
    userState.delete(from);
    await sendMainMenu(from);
    return;
  }

  if (SALES_ORDER_PRINT_KEYWORD.test(trimmed)) {
    await startSalesOrderPrint(from);
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
  } else if (buttonId === 'create_item_save') {
    const state = userState.get(from);
    userState.delete(from);
    if (state?.step === 'awaiting_item_confirm') {
      await saveNewItem(from, state.itemCode, state.itemName);
    }
  } else if (buttonId === 'create_item_cancel') {
    userState.delete(from);
    await sendText(from, 'Item creation cancelled.');
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
      }
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
