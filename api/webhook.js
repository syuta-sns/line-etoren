// api/webhook.js
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { Client, middleware } = require('@line/bot-sdk');
const parser        = require('../metrics/parser');
const compatibility = require('../metrics/compatibility');
const habits        = require('../metrics/habits');
const behavior      = require('../metrics/behavior');
const records       = require('../metrics/records');
const { buildCompatibilityCarousel } = require('../metrics/formatterFlexCarousel');
const { calcZodiacTypeScores } = require('../metrics/zodiac');

// コメントデータ
const commentsData = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../comments.json'), 'utf8')
);

// LINEクライアント
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};
const client = new Client(config);

// スコア帯の取得
function getScoreBand(score) {
  if (score >= 95) return '95';
  if (score >= 90) return '90';
  if (score >= 85) return '85';
  if (score >= 80) return '80';
  if (score >= 70) return '70';
  if (score >= 60) return '60';
  if (score >= 50) return '50';
  return '49';
}

function getShutaComment(category, scoreOrKey) {
  const band = typeof scoreOrKey === 'number'
    ? getScoreBand(scoreOrKey)
    : scoreOrKey;
  return commentsData[category]?.[band] || '';
}

// 重複防止
const recentMessageIds = new Set();
setInterval(() => recentMessageIds.clear(), 5 * 60 * 1000);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  console.log("🧪 Webhook received:", JSON.stringify(req.body, null, 2));
  res.status(200).json({}); // まず即レス

  // 後で非同期処理
  (async () => {
    try {
      let errorSent = false;
      for (const event of req.body.events) {
        try {
          if (event.type === 'message' && event.message.type === 'file') {
            if (recentMessageIds.has(event.message.id)) continue;
            recentMessageIds.add(event.message.id);
          }
          await handleEvent(event);
        } catch (err) {
          console.error('=== 分析中にエラー ===', err);
          if (!errorSent && event.source?.userId) {
            await client.pushMessage(event.source.userId, {
              type: 'text',
              text: '⚠️ 分析中にエラーが発生しました。少々お待ちください🙏'
            });
            errorSent = true;
          }
        }
      }
    } catch (fatal) {
      console.error('🌋 Webhook 処理で致命的なエラー', fatal);
    }
  })();
};

// handleEvent 関数（まるっと移植）
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'file') return;

  const userId = event.source.userId;
  const stream = await client.getMessageContent(event.message.id);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const rawText = Buffer.concat(chunks).toString('utf8');

  const messages  = parser.parseTLText(rawText);
  const profile   = await client.getProfile(userId);
  const { self, other } = parser.extractParticipants(messages, profile.displayName);
  const selfName  = self;
  const otherName = other;

  const recordsData  = records.calcAll({ messages, selfName, otherName });
  const compData     = compatibility.calcAll({ messages, selfName, otherName, recordsData });
  const habitsData   = habits.calcAll({ messages, selfName, otherName });
  const behaviorData = await behavior.calcAll({ messages, selfName, otherName });

  const { animalType, scores: zodiacScores } = calcZodiacTypeScores({
    messages,
    selfName,
    otherName,
    recordsData
  });
  const animalTypeData = commentsData.animalTypes?.[animalType] || {};
  console.log('干支診断 scores: ', zodiacScores);

  const radar = compData.radarScores;
  const lowestCategory = Object.entries(radar).sort((a, b) => a[1] - b[1])[0][0];
  const commentOverall = getShutaComment('overall', compData.overall).replace(/（相手）/g, otherName);
  const comment7p      = getShutaComment('7p', lowestCategory).replace(/（相手）/g, otherName);

  const carousel = buildCompatibilityCarousel({
    selfName,
    otherName,
    radarScores: compData.radarScores,
    overall:     compData.overall,
    habitsData,
    behaviorData,
    recordsData,
    comments: {
      overall: commentOverall,
      time:    commentsData.time,
      balance: commentsData.balance,
      tempo:   commentsData.tempo,
      type:    commentsData.type,
      words:   commentsData.words,
      '7p':    comment7p,
      animalTypes: commentsData.animalTypes,
    },
    animalType,
    animalTypeData,
    zodiacScores,
    promotionalImageUrl: `${process.env.BASE_URL}/images/promotion.png`,
    promotionalLinkUrl:  'https://note.com/enkyorikun/n/n38aad7b8a548'
  });

  // --- ✅ Flexバイトサイズ確認 ---
  if (carousel?.contents?.type === 'carousel' && Array.isArray(carousel.contents.contents)) {
    carousel.contents.contents.forEach((bubble, index) => {
      const msg = {
        type: 'flex',
        altText: `ページ${index + 1}`,
        contents: bubble
      };
      const size = Buffer.byteLength(JSON.stringify(msg), 'utf8');
      console.log(`📦 ページ${index + 1} のサイズ: ${size} bytes`);
    });

    const totalSize = Buffer.byteLength(JSON.stringify(carousel), 'utf8');
    console.log(`📦 全体（carousel）サイズ: ${totalSize} bytes`);
    if (totalSize > 25000) {
      console.warn(`⚠️ Flex Message が 25KB を超えています！`);
    }
  }

  await client.pushMessage(userId, carousel);
}
