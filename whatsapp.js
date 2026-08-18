const axios = require('axios');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

async function sendText(to, body) {
  await axios.post(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function sendButtonMenu(to, bodyText, buttons) {
  await axios.post(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map(({ id, title }) => ({ type: 'reply', reply: { id, title } }))
        }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function sendListMessage(to, bodyText, buttonLabel, rows) {
  await axios.post(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections: [
            {
              title: 'Pending Approvals',
              rows: rows.map(({ id, title, description }) => ({ id, title, description }))
            }
          ]
        }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function uploadMedia(buffer, filename, mimeType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const { data } = await axios.post(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`,
    form,
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
  );
  return data.id;
}

async function sendDocument(to, mediaId, filename) {
  await axios.post(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'document',
      document: { id: mediaId, filename }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

async function sendPdf(to, buffer, filename) {
  const mediaId = await uploadMedia(buffer, filename, 'application/pdf');
  await sendDocument(to, mediaId, filename);
}

module.exports = { sendText, sendPdf, sendButtonMenu, sendListMessage };
