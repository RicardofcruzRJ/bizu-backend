require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');

// =====================================================================
// CONFIGURAÇÃO — defina estas variáveis no painel do Render
// (Environment) ou num arquivo .env local. NUNCA coloque no código.
//
//   MP_ACCESS_TOKEN          -> Mercado Pago > Suas integrações > Credenciais
//                               (Access Token de PRODUÇÃO: APP_USR-...)
//   MP_WEBHOOK_SECRET        -> Mercado Pago > Webhooks > "Assinatura secreta"
//   FIREBASE_SERVICE_ACCOUNT -> JSON completo da conta de serviço
//                               (Firebase Console > Configurações do projeto >
//                               Contas de serviço > Gerar nova chave privada),
//                               colado em UMA linha como valor da variável.
//   WEBHOOK_URL              -> https://SEU-SERVICO.onrender.com/webhook
// =====================================================================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PRECO_ELITE = Number(process.env.PRECO_ELITE || 9.9); // o app exibe R$ 9,90
const DIAS_ELITE = 30;
const MP_API = 'https://api.mercadopago.com/v1/payments';

if (!MP_ACCESS_TOKEN) {
  console.error('MP_ACCESS_TOKEN não configurado.');
}

// --- Firebase Admin (credenciais de serviço) ---
try {
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT
    ? admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    : admin.credential.applicationDefault();
  admin.initializeApp({ credential });
  console.log('Firebase Admin inicializado.');
} catch (error) {
  console.error('Erro ao inicializar o Firebase Admin:', error.message);
  process.exit(1);
}
const db = admin.firestore();

const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.send('BiZu MáXimo Backend Online!'));

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // evita "/" no caminho do documento
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------
// 1. CRIAÇÃO DO PIX
// ---------------------------------------------------------------------
app.post('/gerar-pix', async (req, res) => {
  try {
    const { userId, email } = req.body || {};
    if (typeof userId !== 'string' || !USER_ID_RE.test(userId) ||
        typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'userId e email válidos são obrigatórios.' });
    }
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Pagamentos indisponíveis no momento.' });
    }

    const mpResponse = await fetch(MP_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: PRECO_ELITE,
        payment_method_id: 'pix',
        description: 'Acesso Área Elite - BiZu MáXimo',
        payer: { email },
        external_reference: userId,
        ...(WEBHOOK_URL ? { notification_url: WEBHOOK_URL } : {}),
      }),
    });

    const data = await mpResponse.json();
    if (!mpResponse.ok) {
      console.error('Mercado Pago recusou a criação do Pix:', data);
      return res.status(502).json({ error: 'Não foi possível gerar o Pix.' });
    }

    const pix = data.point_of_interaction?.transaction_data;
    if (!pix?.qr_code) {
      return res.status(502).json({ error: 'Resposta inesperada do Mercado Pago.' });
    }

    return res.status(200).json({
      id: data.id,
      qrCode: pix.qr_code,
      qrCodeBase64: pix.qr_code_base64,
    });
  } catch (error) {
    console.error('Erro em /gerar-pix:', error);
    return res.status(500).json({ error: 'Erro interno ao processar o pagamento.' });
  }
});

// ---------------------------------------------------------------------
// 2. WEBHOOK (SENTINELA)
// ---------------------------------------------------------------------

// Valida o header x-signature enviado pelo Mercado Pago.
function assinaturaValida(req, paymentId) {
  if (!MP_WEBHOOK_SECRET) {
    console.warn('MP_WEBHOOK_SECRET ausente: assinatura do webhook não validada.');
    return true; // o status real é sempre confirmado na API do MP
  }
  const header = req.get('x-signature');
  const requestId = req.get('x-request-id');
  if (!header || !requestId) return false;

  const partes = Object.fromEntries(
    header.split(',').map((p) => p.trim().split('=').map((s) => s.trim()))
  );
  if (!partes.ts || !partes.v1) return false;

  const manifest = `id:${String(paymentId).toLowerCase()};request-id:${requestId};ts:${partes.ts};`;
  const esperado = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  const a = Buffer.from(esperado);
  const b = Buffer.from(partes.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/webhook', async (req, res) => {
  try {
    const { action, data } = req.body || {};
    if (action !== 'payment.created' && action !== 'payment.updated') {
      return res.status(200).send('Evento ignorado');
    }

    const paymentId = req.query['data.id'] || data?.id;
    if (!paymentId || !/^\d+$/.test(String(paymentId))) {
      return res.status(400).send('ID de pagamento inválido');
    }
    if (!assinaturaValida(req, paymentId)) {
      return res.status(401).send('Assinatura inválida');
    }

    // Nunca confie no corpo do webhook: consulte o status real.
    const mpResponse = await fetch(`${MP_API}/${paymentId}`, {
      headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
    });
    if (!mpResponse.ok) {
      return res.status(502).send('Erro ao consultar pagamento'); // MP tentará de novo
    }
    const pagamento = await mpResponse.json();

    if (pagamento.status !== 'approved') {
      return res.status(200).send('Pagamento ainda não aprovado');
    }

    const userId = pagamento.external_reference;
    if (!userId || !USER_ID_RE.test(userId)) {
      return res.status(200).send('Pagamento sem external_reference válido');
    }

    const pagamentoRef = db.collection('pagamentos_processados').doc(String(paymentId));
    const usuarioRef = db.collection('usuarios').doc(userId);

    await db.runTransaction(async (tx) => {
      const [jaProcessado, usuario] = await Promise.all([tx.get(pagamentoRef), tx.get(usuarioRef)]);
      if (jaProcessado.exists) return; // idempotência

      // Renovação antecipada soma 30 dias à validade atual.
      const validadeAtual = usuario.data()?.patenteEliteValidaAte?.toDate?.();
      const base = validadeAtual && validadeAtual > new Date() ? validadeAtual : new Date();
      const novaValidade = new Date(base.getTime() + DIAS_ELITE * 24 * 60 * 60 * 1000);

      tx.set(pagamentoRef, {
        userId,
        status: 'approved',
        processadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(
        usuarioRef,
        {
          patenteEliteAtiva: true,
          isMecenas: true,
          patenteEliteValidaAte: admin.firestore.Timestamp.fromDate(novaValidade),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    return res.status(200).send('Webhook processado');
  } catch (error) {
    console.error('Erro em /webhook:', error);
    return res.status(500).send('Erro interno'); // MP reenviará a notificação
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
