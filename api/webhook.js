// api/webhook.js
module.exports = async (req, res) => {
  console.log('✅ Webhook received');
  res.status(200).send('OK');
};
