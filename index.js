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
      const providerCode = Array.isArray(data.cause)
        ? data.cause.map((cause) => cause?.code).filter(Boolean).join(', ')
        : undefined;
      return res.status(502).json({
        error: 'O Mercado Pago recusou a criação do PIX.',
        ...(providerCode ? { providerCode } : {}),
      });
    }

    const pix = data.point_of_interaction?.transaction_data;
    if (!pix?.qr_code) {
      console.error('Mercado Pago criou resposta sem dados PIX:', {
        paymentId: data.id,
        status: data.status,
        statusDetail: data.status_detail,
      });
      return res.status(502).json({
        error: 'O Mercado Pago não retornou o código PIX.',
        paymentStatus: data.status || 'desconhecido',
        paymentStatusDetail: data.status_detail || 'sem_detalhe',
      });
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

// ---------------------------------------------------------------------
// RANKING TÁTICO GLOBAL — projeção pública mínima e scores server-side.
// O cliente envia apenas o tipo da atividade; pontos e métricas vêm do servidor.
// ---------------------------------------------------------------------
const rankingPublicRef = (uid) => db.collection('ranking_global').doc(uid);
const rankingPrivateRef = (uid) => db.collection('ranking_private').doc(uid);
const rankingEventRef = (uid, eventId) =>
  db.collection('ranking_eventos').doc(`${uid}_${eventId}`);

function dataLocalRanking(date = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const valor = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${valor.year}-${valor.month}-${valor.day}`;
}

function textoPublico(value, fallback, maxLength) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, maxLength);
}

async function dadosPublicosDoRanking(uid, userData, scoreData) {
  let photoUrl = typeof userData.photo_url === 'string' ? userData.photo_url : '';
  if (!photoUrl) {
    try {
      photoUrl = (await admin.auth().getUser(uid)).photoURL || '';
      if (photoUrl) {
        await db.collection('usuarios').doc(uid).set({ photo_url: photoUrl }, { merge: true });
        userData.photo_url = photoUrl;
      }
    } catch (_) {
      // A foto é opcional; a interface usa as iniciais quando ausente.
    }
  }
  if (userData.participar_ranking !== true) {
    await rankingPublicRef(uid).delete();
    return null;
  }

  const shareProgress = userData.compartilhar_progresso_fisico === true;
  const entry = {
    uid,
    participar_ranking: true,
    nome_guerra: textoPublico(userData.nomeGuerra, 'Combatente', 40),
    posto_graduacao: textoPublico(userData.postoGraduacao, 'Não informado', 60),
    om: textoPublico(userData.om, '', 100),
    cidade_estado: textoPublico(userData.cidadeEstado, '', 100),
    photo_url: /^https:\/\//i.test(photoUrl) ? photoUrl.slice(0, 500) : '',
    score: Number.isFinite(scoreData.score) ? scoreData.score : 0,
    dias_streak: Number.isFinite(scoreData.dias_streak) ? scoreData.dias_streak : 0,
    compartilhar_progresso_fisico: shareProgress,
    atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (shareProgress) {
    entry.progresso_fisico = {
      treinos_concluidos: Number(scoreData.treinos_concluidos) || 0,
      distancia_total_metros: Number(scoreData.distancia_total_metros) || 0,
      ...(scoreData.progresso_fisico || {}),
    };
  }
  await rankingPublicRef(uid).set(entry);
  return entry;
}

app.post('/ranking/profile-sync', async (req, res) => {
  const decoded = await verificarTokenFirebase(req);
  if (!decoded) return res.status(401).json({ error: 'Sessão inválida.' });
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    return res.status(403).json({ error: 'Entre em uma conta para usar o ranking.' });
  }
  try {
    const uid = decoded.uid;
    const [userSnapshot, scoreSnapshot] = await Promise.all([
      db.collection('usuarios').doc(uid).get(),
      rankingPrivateRef(uid).get(),
    ]);
    const entry = await dadosPublicosDoRanking(
      uid,
      userSnapshot.data() || {},
      scoreSnapshot.data() || { score: 0 },
    );
    return res.status(200).json({ participates: entry != null });
  } catch (error) {
    console.error('Falha ao sincronizar perfil do ranking:', error.message);
    return res.status(503).json({ error: 'Não foi possível sincronizar o ranking.' });
  }
});

app.post('/ranking/activity', async (req, res) => {
  const decoded = await verificarTokenFirebase(req);
  if (!decoded) return res.status(401).json({ error: 'Sessão inválida.' });
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    return res.status(403).json({ error: 'Entre em uma conta para pontuar no ranking.' });
  }

  try {
    const uid = decoded.uid;
    const tipo = req.body?.type;
    const hoje = dataLocalRanking();
    let eventId;
    let pontos;
    let distanciaMetros = 0;
    let exercicioMetric = null;
    let exercicioValor = 0;
    let streak = 0;

    if (tipo === 'daily_checkin') {
      const userSnapshot = await db.collection('usuarios').doc(uid).get();
      const userData = userSnapshot.data() || {};
      const lastCheckin = paraDate(userData.gamificacao?.ultimoCheckIn);
      if (!lastCheckin || dataLocalRanking(lastCheckin) !== hoje) {
        return res.status(409).json({ error: 'Check-in diário ainda não registrado.' });
      }
      eventId = `checkin_${hoje}`;
      pontos = 5;
      streak = Number(userData.gamificacao?.diasStreak) || 0;
    } else if (tipo === 'taf_run') {
      const treinoSnapshot = await db.collection('usuarios').doc(uid)
        .collection('treinos_taf').doc(hoje).get();
      const run = treinoSnapshot.data()?.metricas?.corrida_metros;
      distanciaMetros = Number(run?.valor) || 0;
      if (!treinoSnapshot.exists || distanciaMetros <= 0 || distanciaMetros > 100000) {
        return res.status(409).json({ error: 'Nenhuma corrida TAF válida foi registrada hoje.' });
      }
      eventId = `taf_${hoje}`;
      pontos = 40 + Math.min(30, Math.floor(distanciaMetros / 1000));
    } else if (tipo === 'taf_exercise') {
      const metric = req.body?.metric;
      const exercisePoints = {
        flexoes: 20,
        barra_fixa: 20,
        abdominais: 20,
      };
      if (!Object.prototype.hasOwnProperty.call(exercisePoints, metric)) {
        return res.status(400).json({ error: 'Métrica de exercício inválida.' });
      }
      const treinoSnapshot = await db.collection('usuarios').doc(uid)
        .collection('treinos_taf').doc(hoje).get();
      const quantidade = Number(treinoSnapshot.data()?.metricas?.[metric]?.valor) || 0;
      if (!treinoSnapshot.exists || quantidade <= 0 || quantidade > 10000) {
        return res.status(409).json({ error: 'Nenhuma métrica válida foi registrada hoje.' });
      }
      exercicioMetric = metric;
      exercicioValor = quantidade;
      eventId = `taf_exercicio_${metric}_${hoje}`;
      pontos = exercisePoints[metric];
    } else if (tipo === 'naval_victory') {
      // Limite de uma recompensa diária evita chamadas repetidas pelo cliente.
      eventId = `naval_${hoje}`;
      pontos = 25;
    } else {
      return res.status(400).json({ error: 'Atividade de ranking desconhecida.' });
    }

    const userRef = db.collection('usuarios').doc(uid);
    const privateRef = rankingPrivateRef(uid);
    const eventRef = rankingEventRef(uid, eventId);
    let awarded = false;
    await db.runTransaction(async (transaction) => {
      const [eventSnapshot, scoreSnapshot, userSnapshot] = await Promise.all([
        transaction.get(eventRef),
        transaction.get(privateRef),
        transaction.get(userRef),
      ]);
      if (eventSnapshot.exists) return;

      const oldScore = scoreSnapshot.data() || {};
      const userData = userSnapshot.data() || {};
      const nextScore = (Number(oldScore.score) || 0) + pontos;
      const updates = {
        score: nextScore,
        atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (tipo === 'daily_checkin') updates.dias_streak = streak;
      if (tipo === 'taf_run') {
        updates.treinos_concluidos = (Number(oldScore.treinos_concluidos) || 0) + 1;
        updates.distancia_total_metros =
          (Number(oldScore.distancia_total_metros) || 0) + distanciaMetros;
        updates.progresso_fisico = {
          ...(oldScore.progresso_fisico || {}),
          ultima_corrida_metros: distanciaMetros,
        };
      } else if (tipo === 'taf_exercise') {
        updates.treinos_concluidos = (Number(oldScore.treinos_concluidos) || 0) + 1;
        updates.progresso_fisico = {
          ...(oldScore.progresso_fisico || {}),
          [exercicioMetric]: exercicioValor,
        };
      }

      transaction.create(eventRef, {
        uid,
        tipo,
        pontos,
        dia: hoje,
        criado_em: admin.firestore.FieldValue.serverTimestamp(),
      });
      transaction.set(privateRef, updates, { merge: true });
      awarded = true;

      if (userData.participar_ranking === true) {
        const mergedScore = { ...oldScore, ...updates };
        const shareProgress = userData.compartilhar_progresso_fisico === true;
        const entry = {
          uid,
          participar_ranking: true,
          nome_guerra: textoPublico(userData.nomeGuerra, 'Combatente', 40),
          posto_graduacao: textoPublico(userData.postoGraduacao, 'Não informado', 60),
          om: textoPublico(userData.om, '', 100),
          cidade_estado: textoPublico(userData.cidadeEstado, '', 100),
          photo_url: /^https:\/\//i.test(userData.photo_url || '')
            ? userData.photo_url.slice(0, 500)
            : '',
          score: nextScore,
          dias_streak: Number(mergedScore.dias_streak) || 0,
          compartilhar_progresso_fisico: shareProgress,
          atualizado_em: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (shareProgress) {
          entry.progresso_fisico = {
            treinos_concluidos: Number(mergedScore.treinos_concluidos) || 0,
            distancia_total_metros: Number(mergedScore.distancia_total_metros) || 0,
            ...(mergedScore.progresso_fisico || {}),
          };
        }
        transaction.set(rankingPublicRef(uid), entry);
      }
    });
    return res.status(200).json({ awarded, points: awarded ? pontos : 0 });
  } catch (error) {
    console.error('Falha ao registrar atividade no ranking:', error.message);
    return res.status(503).json({ error: 'Não foi possível atualizar sua pontuação.' });
  }
});

app.get('/ranking/global', async (req, res) => {
  const decoded = await verificarTokenFirebase(req);
  if (!decoded) return res.status(401).json({ error: 'Sessão inválida.' });
  if (decoded.firebase?.sign_in_provider === 'anonymous') {
    return res.status(403).json({ error: 'Entre em uma conta para consultar o ranking.' });
  }

  try {
    const uid = decoded.uid;
    const filter = ['geral', 'om', 'posto'].includes(req.query.filter)
      ? req.query.filter
      : 'geral';
    const [userSnapshot, scoreSnapshot] = await Promise.all([
      db.collection('usuarios').doc(uid).get(),
      rankingPrivateRef(uid).get(),
    ]);
    const userData = userSnapshot.data() || {};
    const ownEntry = await dadosPublicosDoRanking(
      uid,
      userData,
      scoreSnapshot.data() || { score: 0 },
    );
    if (!ownEntry) {
      return res.status(200).json({
        participates: false,
        entries: [],
        current_user: null,
        current_position: null,
        total_participants: 0,
        filter_value: null,
      });
    }

    let query = db.collection('ranking_global').where('participar_ranking', '==', true);
    const filterValue = filter === 'om'
      ? textoPublico(userData.om, '', 100)
      : filter === 'posto'
        ? textoPublico(userData.postoGraduacao, '', 60)
        : '';
    if (filter === 'om' && filterValue) query = query.where('om', '==', filterValue);
    if (filter === 'posto' && filterValue) {
      query = query.where('posto_graduacao', '==', filterValue);
    }

    if (filter !== 'geral' && !filterValue) {
      return res.status(200).json({
        participates: true,
        entries: [],
        current_user: ownEntry,
        current_position: null,
        total_participants: 0,
        filter_value: null,
      });
    }

    const topSnapshot = await query.orderBy('score', 'desc').limit(50).get();
    let totalParticipants = topSnapshot.size;
    let currentPosition = null;
    try {
      const totalSnapshot = await query.count().get();
      totalParticipants = totalSnapshot.data().count;
      const aheadSnapshot = await query.where('score', '>', ownEntry.score).count().get();
      currentPosition = aheadSnapshot.data().count + 1;
    } catch (error) {
      // Mantém o Top 50 quando a instância Firestore não oferece agregações.
      console.warn('Contagem agregada indisponível no ranking:', error.message);
    }

    return res.status(200).json({
      participates: true,
      entries: topSnapshot.docs.map((document) => document.data()),
      current_user: ownEntry,
      current_position: currentPosition,
      total_participants: totalParticipants,
      filter_value: filterValue || null,
    });
  } catch (error) {
    console.error('Falha ao carregar ranking:', error.message);
    return res.status(503).json({ error: 'Ranking temporariamente indisponível.' });
  }
});


// ---------------------------------------------------------------------
// BATALHA NAVAL ONLINE — salas privadas com jogadas validadas no servidor.
// As frotas ficam em subdocumentos que nunca são enviados ao adversário.
// ---------------------------------------------------------------------
const NAVAL_ROOMS = 'jogos_batalha_naval';
const NAVAL_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const NAVAL_FLEET = [
  { id: 0, name: 'Porta-aviões', size: 5 },
  { id: 1, name: 'Encouraçado', size: 4 },
  { id: 2, name: 'Cruzador', size: 3 },
  { id: 3, name: 'Submarino', size: 3 },
  { id: 4, name: 'Contratorpedeiro', size: 2 },
];

function novoCodigoNaval() {
  return Array.from({ length: 6 }, () =>
    NAVAL_CODE_ALPHABET[crypto.randomInt(NAVAL_CODE_ALPHABET.length)]).join('');
}

function criarFrotaNaval() {
  const occupied = new Set();
  return NAVAL_FLEET.map((ship) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const horizontal = crypto.randomInt(2) === 0;
      const row = crypto.randomInt(horizontal ? 10 : 11 - ship.size);
      const col = crypto.randomInt(horizontal ? 11 - ship.size : 10);
      const cells = Array.from({ length: ship.size }, (_, index) => [
        row + (horizontal ? 0 : index),
        col + (horizontal ? index : 0),
      ]);
      if (cells.some(([r, c]) => occupied.has(`${r}:${c}`))) continue;
      cells.forEach(([r, c]) => occupied.add(`${r}:${c}`));
      return { ...ship, cells };
    }
    throw new Error('Não foi possível posicionar a frota.');
  });
}

function codigoNaval(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

async function nomePublicoNaval(uid, tokenName) {
  const profile = await db.collection('usuarios').doc(uid).get();
  const name = profile.data()?.nomeGuerra || tokenName || 'Combatente';
  return String(name).trim().slice(0, 40) || 'Combatente';
}

async function jogadorDaSala(req, res) {
  const decoded = await verificarTokenFirebase(req);
  if (!decoded) {
    res.status(401).json({ error: 'Sessão Firebase inválida.' });
    return null;
  }
  return decoded;
}

app.post('/jogos/batalha-naval/criar', async (req, res) => {
  const decoded = await jogadorDaSala(req, res);
  if (!decoded) return;
  try {
    const uid = decoded.uid;
    const name = await nomePublicoNaval(uid, decoded.name);
    const fleet = criarFrotaNaval();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = novoCodigoNaval();
      const roomRef = db.collection(NAVAL_ROOMS).doc(code);
      let collision = false;
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(roomRef);
        if (existing.exists) {
          collision = true;
          return;
        }
        tx.create(roomRef, {
          code,
          game: 'batalha_naval',
          status: 'waiting',
          hostUid: uid,
          playerUids: [uid],
          players: [{ uid, name }],
          turnUid: null,
          winnerUid: null,
          shots: [],
          lastAction: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromDate(
            new Date(Date.now() + 24 * 60 * 60 * 1000),
          ),
        });
        tx.create(roomRef.collection('private').doc(uid), { fleet });
      });
      if (!collision) {
        return res.status(201).json({ code, fleet, status: 'waiting' });
      }
    }
    return res.status(503).json({ error: 'Não foi possível abrir a sala. Tente novamente.' });
  } catch (error) {
    console.error('Falha ao criar sala naval:', error.message);
    return res.status(503).json({ error: 'Não foi possível criar a sala agora.' });
  }
});

app.post('/jogos/batalha-naval/entrar', async (req, res) => {
  const decoded = await jogadorDaSala(req, res);
  if (!decoded) return;
  const code = codigoNaval(req.body?.code);
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(code)) {
    return res.status(400).json({ error: 'Informe um código de sala válido.' });
  }
  try {
    const uid = decoded.uid;
    const name = await nomePublicoNaval(uid, decoded.name);
    const fleet = criarFrotaNaval();
    const roomRef = db.collection(NAVAL_ROOMS).doc(code);
    const outcome = await db.runTransaction(async (tx) => {
      const roomSnapshot = await tx.get(roomRef);
      if (!roomSnapshot.exists) return { error: 'Sala não encontrada.', status: 404 };
      const room = roomSnapshot.data();
      if (room.expiresAt?.toDate && room.expiresAt.toDate() < new Date()) {
        return { error: 'Esta sala expirou. Crie uma nova sala.', status: 410 };
      }
      if (room.playerUids.includes(uid)) {
        const ownPrivate = await tx.get(roomRef.collection('private').doc(uid));
        return { room, fleet: ownPrivate.data()?.fleet || [], status: 200 };
      }
      if (room.status !== 'waiting' || room.playerUids.length !== 1) {
        return { error: 'A sala já está cheia ou a partida já começou.', status: 409 };
      }
      if (room.hostUid === uid) {
        return { error: 'O criador da sala precisa entrar com outra conta/dispositivo.', status: 409 };
      }
      const players = [...room.players, { uid, name }];
      tx.create(roomRef.collection('private').doc(uid), { fleet });
      tx.update(roomRef, {
        playerUids: [...room.playerUids, uid],
        players,
        status: 'battle',
        turnUid: room.hostUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { room: { ...room, playerUids: [...room.playerUids, uid], players, status: 'battle', turnUid: room.hostUid }, fleet, status: 200 };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.status(200).json({ code, room: outcome.room, fleet: outcome.fleet });
  } catch (error) {
    console.error('Falha ao entrar na sala naval:', error.message);
    return res.status(503).json({ error: 'Não foi possível entrar na sala agora.' });
  }
});

app.get('/jogos/batalha-naval/:code/estado', async (req, res) => {
  const decoded = await jogadorDaSala(req, res);
  if (!decoded) return;
  const code = codigoNaval(req.params.code);
  try {
    const roomRef = db.collection(NAVAL_ROOMS).doc(code);
    const [roomSnapshot, privateSnapshot] = await Promise.all([
      roomRef.get(),
      roomRef.collection('private').doc(decoded.uid).get(),
    ]);
    if (!roomSnapshot.exists || !roomSnapshot.data().playerUids.includes(decoded.uid)) {
      return res.status(404).json({ error: 'Sala não encontrada para este jogador.' });
    }
    return res.status(200).json({
      code,
      room: { ...roomSnapshot.data(), id: roomSnapshot.id },
      fleet: privateSnapshot.data()?.fleet || [],
    });
  } catch (error) {
    console.error('Falha ao consultar sala naval:', error.message);
    return res.status(503).json({ error: 'Não foi possível carregar a sala.' });
  }
});

app.post('/jogos/batalha-naval/:code/tiro', async (req, res) => {
  const decoded = await jogadorDaSala(req, res);
  if (!decoded) return;
  const code = codigoNaval(req.params.code);
  const row = Number(req.body?.row);
  const col = Number(req.body?.col);
  const actionId = typeof req.body?.actionId === 'string'
    ? req.body.actionId.slice(0, 80)
    : crypto.randomUUID();
  if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(code) ||
      !Number.isInteger(row) || !Number.isInteger(col) ||
      row < 0 || row > 9 || col < 0 || col > 9) {
    return res.status(400).json({ error: 'Coordenada de tiro inválida.' });
  }
  try {
    const uid = decoded.uid;
    const roomRef = db.collection(NAVAL_ROOMS).doc(code);
    const result = await db.runTransaction(async (tx) => {
      const roomSnapshot = await tx.get(roomRef);
      if (!roomSnapshot.exists) return { error: 'Sala não encontrada.', status: 404 };
      const room = roomSnapshot.data();
      if (!room.playerUids.includes(uid) || room.playerUids.length !== 2) {
        return { error: 'Você não participa desta partida.', status: 403 };
      }
      if (room.status !== 'battle') {
        return { error: 'A partida não está em andamento.', status: 409 };
      }
      if (room.turnUid !== uid) return { error: 'Aguarde a sua vez.', status: 409 };
      if (room.shots.some((shot) => shot.actionId === actionId)) {
        return { room, duplicate: true };
      }
      const targetUid = room.playerUids.find((playerUid) => playerUid !== uid);
      if (room.shots.some((shot) =>
        shot.attackerUid === uid && shot.row === row && shot.col === col)) {
        return { error: 'Você já disparou nesta coordenada.', status: 409 };
      }
      const privateRef = roomRef.collection('private').doc(targetUid);
      const privateSnapshot = await tx.get(privateRef);
      const fleet = privateSnapshot.data()?.fleet || [];
      const ship = fleet.find((item) => item.cells.some((cell) => cell[0] === row && cell[1] === col));
      const shots = [...room.shots];
      const action = {
        actionId,
        attackerUid: uid,
        targetUid,
        row,
        col,
        hit: Boolean(ship),
        sunkShip: null,
        createdAt: admin.firestore.Timestamp.now(),
      };
      shots.push(action);
      const hits = new Set(shots
        .filter((shot) => shot.targetUid === targetUid && shot.hit)
        .map((shot) => `${shot.row}:${shot.col}`));
      if (ship && ship.cells.every((cell) => hits.has(`${cell[0]}:${cell[1]}`))) {
        action.sunkShip = ship.name;
      }
      const victory = fleet.every((item) =>
        item.cells.every((cell) => hits.has(`${cell[0]}:${cell[1]}`)));
      const status = victory ? 'finished' : 'battle';
      const updated = {
        shots,
        lastAction: action,
        status,
        turnUid: victory ? null : targetUid,
        winnerUid: victory ? uid : null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      tx.update(roomRef, updated);
      return { room: { ...room, ...updated }, duplicate: false };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(200).json({ duplicate: result.duplicate, room: result.room });
  } catch (error) {
    console.error('Falha ao registrar tiro naval:', error.message);
    return res.status(503).json({ error: 'Não foi possível registrar o disparo.' });
  }
});

app.get('/jogos/batalha-naval/:code/eventos', async (req, res) => {
  const decoded = await jogadorDaSala(req, res);
  if (!decoded) return;
  const code = codigoNaval(req.params.code);
  const roomRef = db.collection(NAVAL_ROOMS).doc(code);
  try {
    const initial = await roomRef.get();
    if (!initial.exists || !initial.data().playerUids.includes(decoded.uid)) {
      return res.status(404).json({ error: 'Sala não encontrada para este jogador.' });
    }
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const sendRoom = (snapshot) => {
      if (!snapshot.exists || !snapshot.data().playerUids.includes(decoded.uid)) {
        res.write(`event: room-error\ndata: ${JSON.stringify({ error: 'Acesso à sala encerrado.' })}\n\n`);
        return;
      }
      res.write(`data: ${JSON.stringify({ room: { ...snapshot.data(), id: snapshot.id } })}\n\n`);
    };
    sendRoom(initial);
    const unsubscribe = roomRef.onSnapshot(sendRoom, (error) => {
      console.error('Erro no stream da sala naval:', error.message);
      if (!res.writableEnded) res.end();
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch (error) {
    console.error('Falha ao abrir stream naval:', error.message);
    if (!res.headersSent) return res.status(503).json({ error: 'Não foi possível acompanhar a sala.' });
    return res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
