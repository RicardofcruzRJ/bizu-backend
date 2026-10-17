const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
require('dotenv').config();

// Inicialização segura do Firebase Admin
try {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccountContent = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    // Verifica se está a vir como string JSON e converte para objeto
    const serviceAccount = typeof serviceAccountContent === 'string' 
      ? JSON.parse(serviceAccountContent) 
      : serviceAccountContent;
      
    credential = admin.credential.cert(serviceAccount);
  } else {
    credential = admin.credential.applicationDefault();
  }

  admin.initializeApp({ credential });
  console.log('Firebase Admin inicializado com sucesso.');
} catch (error) {
  console.error('Erro crítico ao inicializar o Firebase Admin:', error.message);
}

const db = admin.firestore();
const app = express();
app.use(express.json());
app.use(cors());

// Rota de Teste
app.get('/', (req, res) => {
  res.send('BiZu MáXimo Backend Online!');
});

// 1. ROTA PARA GERAR O PIX ELITE
app.post('/gerar-pix', async (req, res) => {
  try {
    const { userId, email } = req.body;
    if (!userId || !email) {
      return res.status(400).json({ error: 'userId e email são obrigatórios.' });
    }

    const mpAccessToken = process.env.MP_ACCESS_TOKEN;
    if (!mpAccessToken) {
      return res.status(500).json({ error: 'Token do Mercado Pago não configurado no servidor.' });
    }

    const paymentData = {
      transaction_amount: 9.90, // Valor da Patente Elite
      description: 'Assinatura Mensal - BiZu MáXimo Patente Elite',
      payment_method_id: 'pix',
      payer: { email: email },
      external_reference: userId
    };

    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mpAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(paymentData)
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(400).json({ error: data.message || 'Erro ao gerar Pix no Mercado Pago' });
    }

    return res.status(200).json({
      paymentId: data.id,
      qrCode: data.point_of_interaction.transaction_data.qr_code,
      qrCodeBase64: data.point_of_interaction.transaction_data.qr_code_base64
    });

  } catch (error) {
    console.error('Erro ao gerar Pix:', error);
    return res.status(500).json({ error: 'Erro interno ao processar o pagamento.' });
  }
});

// 2. WEBHOOK DO MERCADO PAGO (Com Idempotência e Expiração de 30 dias)
app.post('/webhook', async (req, res) => {
  try {
    const { action, data } = req.body;
    if (action !== 'payment.created' && action !== 'payment.updated') {
      return res.status(200).send('Evento ignorado');
    }

    const paymentId = data.id;
    const mpAccessToken = process.env.MP_ACCESS_TOKEN;

    // Busca os detalhes do pagamento na API do Mercado Pago
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${mpAccessToken}` }
    });

    const paymentInfo = await mpResponse.json();
    if (!mpResponse.ok) return res.status(500).json({ error: 'Erro ao consultar pagamento' });

    if (paymentInfo.status === 'approved') {
      const userId = paymentInfo.external_reference;
      if (!userId) return res.status(200).send('Sem external_reference');

      // IDEMPOTÊNCIA: Verifica se o pagamento já foi processado
      const pagamentoRef = db.collection('pagamentos_processados').doc(String(paymentId));
      const pagamentoDoc = await pagamentoRef.get();

      if (pagamentoDoc.exists) {
        return res.status(200).send('Pagamento já processado');
      }

      // Calcula a validade de 30 dias
      const dataExpiracao = new Date();
      dataExpiracao.setDate(dataExpiracao.getDate() + 30);

      // Executa a transação no Firestore com segurança
      await db.runTransaction(async (transaction) => {
        transaction.set(pagamentoRef, {
          processadoEm: admin.firestore.FieldValue.serverTimestamp(),
          userId: userId,
          status: 'approved'
        });

        const usuarioRef = db.collection('usuarios').doc(userId);
        transaction.update(usuarioRef, {
          isMecenas: true,
          patenteEliteAtiva: true,
          patenteEliteValidaAte: admin.firestore.Timestamp.fromDate(dataExpiracao),
          atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
        });
      });
    }

    return res.status(200).send('Webhook recebido com sucesso');
  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.status(500).send('Erro interno');
  }
});

// 3. ROTA DA INTELIGÊNCIA TÁTICA (OPENAI)
app.post('/api/chat', async (req, res) => {
  try {
    const { token, messages } = req.body;

    // Validação do Token
    if (!token) {
      return res.status(401).json({ error: 'Token de autenticação não fornecido. Acesso negado.' });
    }

    // Verifica no Firebase se o token é de um utilizador autêntico
    await admin.auth().verifyIdToken(token);

    // Constrói a regra militar restrita
    const systemPrompt = {
      role: 'system',
      content: 'Você é o assistente virtual oficial do aplicativo BiZu Máximo, voltado para o público militar. Sua missão exclusiva é responder dúvidas estritamente relacionadas a assuntos militares, regulamentos, história das Forças Armadas e preparação física voltada para o TAF, TFM, suplementação e nutrição. Se o utilizador fizer perguntas fora desse escopo, recuse educadamente.'
    };

    const fullMessages = [systemPrompt, ...(messages || [])];

    // Chamada à API da OpenAI utilizando fetch nativo
    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: fullMessages,
        temperature: 0.7
      })
    });

    const openAiData = await openAiResponse.json();

    if (!openAiResponse.ok) {
      console.error('Erro retornado pela OpenAI:', openAiData);
      // Se a chave for inválida ou limite for atingido, retorna 503/504 para o Flutter tratar
      return res.status(503).json({ error: 'Serviço de IA indisponível no momento.' });
    }

    const reply = openAiData.choices[0].message.content;
    return res.status(200).json({ reply });

  } catch (error) {
    console.error('Erro no Assistente IA:', error);
    // Trata especificamente o caso do token do Firebase expirar
    if (error.code && error.code.startsWith('auth/')) {
      return res.status(401).json({ error: 'Sessão expirada. Por favor, faça login novamente.' });
    }
    return res.status(500).json({ error: 'Erro interno no servidor tático.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
