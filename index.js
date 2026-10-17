require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');

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
//   OPENAI_API_KEY            -> chave da API OpenAI (configurar somente no Render)
//   OPENAI_MODEL              -> opcional; padrão: gpt-4o-mini
//   WEBHOOK_URL              -> https://SEU-SERVICO.onrender.com/webhook
// =====================================================================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const CONTRACT_VERSION = '1.0';
const PRODUTOS_ASSINATURA = Object.freeze({
  elite_mensal: {
    preco: 9.90,
    dias: 30,
    isElite: true,
    descricao: 'BiZu MáXimo - Área Elite (30 dias)',
    campoExpiracao: 'elite_expiry_date',
  },
  elite_trimestral: {
    preco: 19.80,
    dias: 90,
    isElite: true,
    descricao: 'BiZu MáXimo - Área Elite (90 dias)',
    campoExpiracao: 'elite_expiry_date',
  },
  ia_avulso: {
    preco: 4.90,
    dias: 30,
    isElite: false,
    descricao: 'BiZu MáXimo - Pacote IA Tática (30 dias)',
    campoExpiracao: 'ai_expiry_date',
  },
});
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
app.use(cors());
app.use(express.json());

app.get('/', (_req, res) => res.send('BiZu MáXimo Backend Online!'));

// ---------------------------------------------------------------------
// ASSISTENTE IA
// ---------------------------------------------------------------------
const systemPrompt = `Você é a "Inteligência Tática", o treinador de elite e mentor militar do aplicativo BiZu Máximo. O seu objetivo é fazer com que o usuário se sinta priorizado, motivado e seguro de que a assinatura Premium do app vale cada centavo. Seja acolhedor, tático, direto e altamente motivacional.

Você está autorizado a fornecer respostas detalhadas sobre os seguintes quadros:
1. Gerador de Cronograma TAF/Treino: crie cronogramas completos e progressivos. Explique corrida, biomecânica, técnica, tipos de pisada, terrenos, músculos acionados e fortalecimento para melhorar o desempenho e reduzir risco de lesões.
2. Nutrição e Suplementação: dê orientações gerais sobre alimentação, Whey Protein, creatina, pré-treinos, hidratação e recuperação muscular. Não prescreva dietas clínicas nem substitua avaliação profissional.
3. Bizus de Carreira e Caserna: forneça conselhos práticos sobre rotina militar, liderança, escalas e comportamento na caserna.
4. Dúvidas de Regulamentos: responda sobre história das Forças Armadas, hierarquia, leis e normas militares. Sinalize quando a regra puder estar desatualizada e recomende conferir a fonte oficial.

Regras:
- Responda aos pedidos dentro desses temas com conteúdo rico, prático e baseado em conhecimento confiável.
- Trate o usuário como um guerreiro em busca de excelência física e mental, mantendo respeito e empatia.
- Não invente informações nem incentive treinar com dor ou ignorar contraindicações. Adapte os treinos ao nível informado e sugira progressão gradual.
- Ao sugerir treino intenso ou abordar dores e lesões, encerre com: "Lembre-se, guerreiro: a Inteligência Tática não substitui o acompanhamento de um médico, nutricionista ou educador físico. Ao primeiro sinal de dor ou lesão, procure um profissional de saúde."`;

app.post('/api/chat', async (req, res) => {
  const { token, messages } = req.body || {};
  if (typeof token !== 'string' || !Array.isArray(messages) || messages.length === 0 ||
      messages.length > 30 || messages.some((message) =>
        !message || !['user', 'assistant'].includes(message.role) ||
        typeof message.content !== 'string' || !message.content.trim() ||
        message.content.length > 8000)) {
    return res.status(400).json({ error: 'Token ou histórico de conversa inválido.' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const [subscriptionSnapshot, userSnapshot] = await Promise.all([
      assinaturaRef(decoded.uid).get(),
      db.collection('usuarios').doc(decoded.uid).get(),
    ]);
    const assinatura = subscriptionSnapshot.data() || {};
    const usuario = userSnapshot.data() || {};
    if (!trialAtivo(assinatura) &&
        !acessoEliteAtivo(assinatura, usuario) &&
        !acessoIaAtivo(assinatura)) {
      return res.status(403).json({ error: 'Assinatura IA ou Elite necessária.' });
    }
  } catch (error) {
    console.error('Falha ao validar acesso do Assistente IA:', error.message);
    return res.status(error.code === 'auth/argument-error' ||
        error.code === 'auth/id-token-expired' ? 401 : 503)
      .json({ error: 'Não foi possível validar o acesso ao Assistente IA.' });
  }

  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY não configurada.');
    return res.status(503).json({ error: 'Assistente indisponível no momento.' });
  }

  try {
    const aiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map(({ role, content }) => ({ role, content: content.trim() })),
        ],
        temperature: 0.6,
      }),
      signal: AbortSignal.timeout(40000),
    });

    const result = await aiResponse.json();
    if (!aiResponse.ok) {
      console.error('Provedor de IA recusou a solicitação:', aiResponse.status, result.error?.type);
      return res.status(aiResponse.status === 429 ? 429 : 502)
        .json({ error: 'Não foi possível gerar a resposta agora.' });
    }

    const reply = result.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      return res.status(502).json({ error: 'O assistente retornou uma resposta vazia.' });
    }
    return res.status(200).json({ reply });
  } catch (error) {
    console.error('Erro ao consultar o assistente:', error.name || error.message);
    return res.status(error.name === 'TimeoutError' ? 504 : 502)
      .json({ error: 'O assistente demorou a responder. Tente novamente.' });
  }
});

const USER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // evita "/" no caminho do documento
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const assinaturaRef = (uid) => db.collection('usuarios').doc(uid)
  .collection('assinatura').doc('estado');

function paraDate(valor) {
  let data = null;
  if (valor && typeof valor.toDate === 'function') data = valor.toDate();
  else if (typeof valor === 'string') data = new Date(valor);
  return data instanceof Date && Number.isFinite(data.getTime()) ? data : null;
}

function accessTokenDoRequest(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function verificarTokenFirebase(req) {
  const token = accessTokenDoRequest(req);
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (_) {
    return null;
  }
}

function acessoEliteAtivo(assinatura, usuario, agora = new Date()) {
  const expiry = paraDate(assinatura?.elite_expiry_date);
  if (expiry) return expiry > agora;
  const validadeLegada = paraDate(usuario?.patenteEliteValidaAte);
  const legadoAtivo = usuario?.patenteEliteAtiva === true || usuario?.isMecenas === true;
  return legadoAtivo && (!validadeLegada || validadeLegada > agora);
}

function acessoIaAtivo(assinatura, agora = new Date()) {
  const expiry = paraDate(assinatura?.ai_expiry_date);
  return expiry != null && expiry > agora;
}

function trialAtivo(assinatura, agora = new Date()) {
  const inicio = paraDate(assinatura?.trial_start_date);
  return inicio != null && agora.getTime() - inicio.getTime() < 7 * 24 * 60 * 60 * 1000 &&
    agora >= inicio;
}

// Cria o trial no relógio do servidor no primeiro acesso autenticado.
app.get('/assinatura/status', async (req, res) => {
  const decoded = await verificarTokenFirebase(req);
  if (!decoded) return res.status(401).json({ error: 'Sessão inválida. Entre novamente.' });

  try {
    const userRef = db.collection('usuarios').doc(decoded.uid);
    const stateRef = assinaturaRef(decoded.uid);
    let state;
    let userData;
    await db.runTransaction(async (tx) => {
      const [stateSnapshot, userSnapshot] = await Promise.all([
        tx.get(stateRef),
        tx.get(userRef),
      ]);
      state = stateSnapshot.data() || {};
      userData = userSnapshot.data() || {};
      if (!paraDate(state.trial_start_date)) {
        const now = admin.firestore.Timestamp.now();
        state = {
          ...state,
          trial_start_date: now,
          elite_expiry_date: state.elite_expiry_date || null,
          ai_expiry_date: state.ai_expiry_date || null,
          contrato_aceite: state.contrato_aceite === true,
          contrato_data_aceite: state.contrato_data_aceite || null,
          contrato_versao: state.contrato_versao || CONTRACT_VERSION,
        };
        tx.set(stateRef, {
          ...state,
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });

    const now = new Date();
    const start = paraDate(state.trial_start_date);
    const trialRemainingMs = start
      ? Math.max(0, 7 * 24 * 60 * 60 * 1000 - (now.getTime() - start.getTime()))
      : 0;
    const trialDaysRemaining = Math.ceil(trialRemainingMs / (24 * 60 * 60 * 1000));
    const eliteExpiry = paraDate(state.elite_expiry_date) ||
      paraDate(userData.patenteEliteValidaAte);
    const aiExpiry = paraDate(state.ai_expiry_date);

    return res.status(200).json({
      trial_start_date: start?.toISOString() || null,
      trial_active: trialAtivo(state, now),
      trial_days_remaining: trialDaysRemaining,
      elite_expiry_date: eliteExpiry?.toISOString() || null,
      ai_expiry_date: aiExpiry?.toISOString() || null,
      elite_active: acessoEliteAtivo(state, userData, now),
      ai_active: acessoIaAtivo(state, now),
      contrato_aceite: state.contrato_aceite === true,
      contrato_versao: state.contrato_versao || CONTRACT_VERSION,
    });
  } catch (error) {
    console.error('Erro ao carregar assinatura:', error.message);
    return res.status(500).json({ error: 'Não foi possível validar a assinatura.' });
  }
});

// ---------------------------------------------------------------------
// 1. CRIAÇÃO DO PIX
// ---------------------------------------------------------------------
app.post('/gerar-pix', async (req, res) => {
  try {
    const decoded = await verificarTokenFirebase(req);
    if (!decoded) {
      return res.status(401).json({ error: 'Sessão inválida. Entre novamente.' });
    }

    const { productId, accepted, contractVersion } = req.body || {};
    const produto = PRODUTOS_ASSINATURA[productId];
    if (!produto) {
      return res.status(400).json({ error: 'Pacote não reconhecido.' });
    }
    if (accepted !== true || contractVersion !== CONTRACT_VERSION) {
      return res.status(400).json({ error: 'Aceite os termos vigentes antes de gerar o PIX.' });
    }
    const userId = decoded.uid;
    const email = decoded.email;
    if (!USER_ID_RE.test(userId) || typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return res.status(403).json({ error: 'Entre em uma conta com e-mail para comprar um pacote.' });
    }
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'Pagamentos indisponíveis no momento.' });
    }

    // Registra o aceite com horário do servidor antes de solicitar a cobrança.
    const stateRef = assinaturaRef(userId);
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(stateRef);
      const atual = snapshot.data() || {};
      tx.set(stateRef, {
        trial_start_date: atual.trial_start_date || admin.firestore.Timestamp.now(),
        elite_expiry_date: atual.elite_expiry_date || null,
        ai_expiry_date: atual.ai_expiry_date || null,
        contrato_aceite: true,
        contrato_data_aceite: admin.firestore.Timestamp.now(),
        contrato_versao: CONTRACT_VERSION,
        contrato_plano_id: productId,
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    const mpResponse = await fetch(MP_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: produto.preco,
        payment_method_id: 'pix',
        description: produto.descricao,
        payer: { email },
        external_reference: userId,
        metadata: {
          user_id: userId,
          product_id: productId,
          contract_version: CONTRACT_VERSION,
        },
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
      productId,
      durationDays: produto.dias,
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

    const userId = pagamento.metadata?.user_id || pagamento.external_reference;
    if (!userId || !USER_ID_RE.test(userId)) {
      return res.status(200).send('Pagamento sem external_reference válido');
    }

    // Compatibilidade com cobranças Elite antigas sem metadata de produto.
    const productId = pagamento.metadata?.product_id || 'elite_mensal';
    const produto = PRODUTOS_ASSINATURA[productId];
    if (!produto) {
      console.error('Pagamento aprovado com pacote desconhecido:', productId);
      return res.status(200).send('Pacote de pagamento desconhecido');
    }

    const pagamentoRef = db.collection('pagamentos_processados').doc(String(paymentId));
    const usuarioRef = db.collection('usuarios').doc(userId);
    const stateRef = assinaturaRef(userId);

    await db.runTransaction(async (tx) => {
      const [jaProcessado, usuario, assinatura] = await Promise.all([
        tx.get(pagamentoRef),
        tx.get(usuarioRef),
        tx.get(stateRef),
      ]);
      if (jaProcessado.exists) return; // idempotência

      const dadosAssinatura = assinatura.data() || {};
      const campo = produto.campoExpiracao;
      const validadeAtual = paraDate(dadosAssinatura[campo]) ||
        (produto.isElite ? paraDate(usuario.data()?.patenteEliteValidaAte) : null);
      const base = validadeAtual && validadeAtual > new Date() ? validadeAtual : new Date();
      const novaValidade = new Date(base.getTime() + produto.dias * 24 * 60 * 60 * 1000);

      tx.set(pagamentoRef, {
        userId,
        productId,
        amount: produto.preco,
        status: 'approved',
        processadoEm: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.set(stateRef, {
        ...dadosAssinatura,
        [campo]: admin.firestore.Timestamp.fromDate(novaValidade),
        atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      if (produto.isElite) {
        tx.set(usuarioRef, {
          patenteEliteAtiva: true,
          isMecenas: true,
          patenteEliteValidaAte: admin.firestore.Timestamp.fromDate(novaValidade),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });

    return res.status(200).send('Webhook processado');
  } catch (error) {
    console.error('Erro em /webhook:', error);
    return res.status(500).send('Erro interno'); // MP reenviará a notificação
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
