// Import Express.js
const express = require('express');
const { getItems } = require('./sap');
const { sendText } = require('./whatsapp');

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

async function handleIncomingMessage(from, text) {
  if (ITEMS_KEYWORD.test(text.trim())) {
    try {
      const items = await getItems();
      await sendText(from, formatItemList(items));
    } catch (err) {
      console.error('Failed to fetch/send item list:', err.message);
      await sendText(from, 'Sorry, could not fetch the item list right now. Please try again later.');
    }
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
        handleIncomingMessage(message.from, message.text.body).catch((err) =>
          console.error('Error handling message:', err.message)
        );
      }
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`\nListening on port ${port}\n`);
});
