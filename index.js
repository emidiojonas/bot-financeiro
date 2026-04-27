require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const MEU_CHAT_ID = String(process.env.MEU_CHAT_ID);
const RENDER_URL = 'https://bot-financeiro-eu35.onrender.com';

// Categorias
const CC_CATS = ['Mercado','Feira','Padaria','Transporte','Lazer','Vestimenta','Eletrônicos','Utensílios para casa','Eletrodomésticos','Móveis','Presentes','Assinaturas','Farmácia','Saúde/Consultas','Restaurantes','Acessórios','Uber','Livros','Manutenção','iFood','Gasolina','Outros'];
const FIX_CATS = ['Aluguel','Água','Luz','Internet','Celular','TV','Plano funerário','Plano de Saúde','Empréstimo 1','Empréstimo 2','Empréstimo 3','Dízimo','Ofertas'];

const CC_KEYWORDS = [
  ['mercado','supermercado'],['feira'],['padaria','cafeteria','cafe'],
  ['transporte','onibus','metro','trem','passagem'],['lazer','cinema','teatro','show'],
  ['vestimenta','roupa','calcado','sapato','tenis'],['eletronico','notebook','tablet','celular compra'],
  ['utensilio','panela','copo','prato'],['eletrodomestico','geladeira','fogao','microondas'],
  ['movel','sofa','cama','guarda roupa'],['presente'],
  ['assinatura','netflix','spotify','amazon','disney','streaming'],
  ['farmacia','remedio','medicamento','comprimido'],
  ['saude','consulta','medico','dentista','exame','hospital','clinica'],
  ['restaurante','lanchonete','pizzaria','pizza','lanche','almoco','jantar'],
  ['acessorio','bolsa','mochila','cinto','relogio','oculos'],
  ['uber','99','cabify','taxi'],['livro','livraria'],
  ['manutencao','conserto','reparo','tecnico','oficina'],
  ['ifood','delivery'],['gasolina','combustivel','posto'],
  ['outros','outro']
];
const FIX_KEYWORDS = [
  ['aluguel'],['agua','conta de agua'],['luz','energia','conta de luz'],['internet','wifi'],
  ['celular','plano celular','telefone'],['tv','televisao'],
  ['plano funerario','funeral'],['plano de saude','plano saude'],
  ['emprestimo 1','prestacao 1','parcela 1'],
  ['emprestimo 2','prestacao 2','parcela 2'],
  ['emprestimo 3','prestacao 3','parcela 3'],
  ['dizimo','dízimo'],['oferta','ofertas']
];

// Normalização
function normalize(str) {
  return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ');
}
function fmt(v) {
  return 'R$ ' + Number(v||0).toFixed(2).replace('.',',');
}
function extractValue(text) {
  const m = text.match(/(\d{1,6}[.,]\d{2}|\d{1,6})/);
  return m ? parseFloat(m[1].replace(',','.')) : null;
}
function extractCategory(norm) {
  for (let i=0; i<CC_KEYWORDS.length; i++)
    for (const kw of CC_KEYWORDS[i])
      if (norm.includes(kw)) return {cat: CC_CATS[i], tipo: 'cc'};
  for (let i=0; i<FIX_KEYWORDS.length; i++)
    for (const kw of FIX_KEYWORDS[i])
      if (norm.includes(kw)) return {cat: FIX_CATS[i], tipo: 'fix'};
  return null;
}
function extractObs(text, cat) {
  if (cat !== 'Outros') return null;
  const m = text.match(/[-—:]\s*(.+)$/);
  return m ? m[1].trim() : null;
}

// Detecta qual cartão foi mencionado
function extractCartao(norm, cartoes) {
  for (let i = 0; i < cartoes.length; i++) {
    if (!cartoes[i]?.nome) continue;
    const nomeNorm = normalize(cartoes[i].nome);
    if (norm.includes(nomeNorm)) return i;
    // Apelidos parciais (ex: "neon" encontra "Cartão Neon")
    const parts = nomeNorm.split(' ');
    for (const part of parts) {
      if (part.length > 2 && norm.includes(part)) return i;
    }
  }
  return null;
}

async function getConfig() {
  const {data} = await supabase.from('configuracoes').select('dados').eq('id',1).single();
  return data?.dados || {salario:0, cartoes:[], orcCC:{}, orcFix:{}};
}

async function processMessage(text) {
  const norm = normalize(text);
  const cfg = await getConfig();
  const mes = new Date().toISOString().slice(0,7);
  const cartoes = cfg.cartoes || [];

  // ── CONSULTAS ──

  // Saldo disponível geral
  if (/saldo\s*(disponivel|geral|total)?$|quanto.*gastar/.test(norm)) {
    const {data} = await supabase.from('transactions').select('valor').gte('data', mes+'-01');
    const total = (data||[]).reduce((s,t)=>s+parseFloat(t.valor),0);
    const saldo = cfg.salario - total;
    return `💰 *Saldo disponível*\n\nSalário: ${fmt(cfg.salario)}\nGasto no mês: ${fmt(total)}\nSaldo: *${fmt(saldo)}*`;
  }

  // Saldo/limite de cartão específico
  const saldoCartaoMatch = norm.match(/saldo.*cartao|limite.*cartao|cartao.*saldo|cartao.*limite/);
  if (saldoCartaoMatch || /quanto.*cartao|cartao.*quanto/.test(norm)) {
    const idx = extractCartao(norm, cartoes);
    if (idx !== null) {
      const cartao = cartoes[idx];
      const {data} = await supabase.from('transactions').select('valor').eq('tipo','cc').eq('cartao_idx', idx).gte('data', mes+'-01');
      const gasto = (data||[]).reduce((s,t)=>s+parseFloat(t.valor),0);
      const limite = cartao.limite || 0;
      const saldo = limite - gasto;
      return `💳 *${cartao.nome}*\n\nLimite: ${fmt(limite)}\nGasto no mês: ${fmt(gasto)}\nDisponível: *${fmt(saldo)}*`;
    }
    // Lista todos os cartões
    let r = '💳 *Resumo dos Cartões*\n\n';
    for (let i=0; i<cartoes.length; i++) {
      if (!cartoes[i]?.nome) continue;
      const {data} = await supabase.from('transactions').select('valor').eq('tipo','cc').eq('cartao_idx',i).gte('data',mes+'-01');
      const gasto = (data||[]).reduce((s,t)=>s+parseFloat(t.valor),0);
      const limite = cartoes[i].limite||0;
      r += `*${cartoes[i].nome}*: ${fmt(gasto)} de ${fmt(limite)} (disponível: ${fmt(limite-gasto)})\n`;
    }
    return r.trim();
  }

  // Orçamento de categoria específica
  const orcCats = [...CC_CATS, ...FIX_CATS];
  const orcKeys = [...Array(CC_CATS.length).fill('cc'), ...Array(FIX_CATS.length).fill('fix')];
  if (/orcamento|quanto.*ainda|saldo.*categoria|restante/.test(norm)) {
    for (let i=0; i<orcCats.length; i++) {
      const catNorm = normalize(orcCats[i]);
      const parts = catNorm.split(' ');
      const found = parts.some(p => p.length > 2 && norm.includes(p));
      if (found) {
        const cat = orcCats[i];
        const tipo = orcKeys[i];
        const orcMap = tipo==='cc' ? cfg.orcCC : cfg.orcFix;
        // encontrar chave do orçamento
        const orcVal = Object.values(orcMap||{})[i] || 0;
        const {data} = await supabase.from('transactions').select('valor').eq('categoria',cat).gte('data',mes+'-01');
        const gasto = (data||[]).reduce((s,t)=>s+parseFloat(t.valor),0);
        const orc = parseFloat(orcVal)||0;
        const restante = orc - gasto;
        return `📊 *${cat}*\n\nOrçamento: ${fmt(orc)}\nGasto: ${fmt(gasto)}\nRestante: *${fmt(restante)}*`;
      }
    }
  }

  // Resumo completo
  if (/resumo|relatorio|situacao/.test(norm)) {
    const {data} = await supabase.from('transactions').select('valor,tipo,categoria').gte('data',mes+'-01');
    const txns = data||[];
    const cc = txns.filter(t=>t.tipo==='cc').reduce((s,t)=>s+parseFloat(t.valor),0);
    const fix = txns.filter(t=>t.tipo==='fix').reduce((s,t)=>s+parseFloat(t.valor),0);
    const cats = [...CC_CATS,...FIX_CATS];
    const top = cats.map(c=>({c,v:txns.filter(t=>t.categoria===c).reduce((s,t)=>s+parseFloat(t.valor),0)}))
      .filter(x=>x.v>0).sort((a,b)=>b.v-a.v).slice(0,5);
    let r = `📊 *Resumo do mês*\n\nSalário: ${fmt(cfg.salario)}\nFixas: ${fmt(fix)}\nVariáveis: ${fmt(cc)}\nSaldo: *${fmt(cfg.salario-cc-fix)}*`;
    if (top.length) { r+='\n\n🏆 *Maiores gastos:*\n'; top.forEach(x=>{ r+=`  • ${x.c}: ${fmt(x.v)}\n`; }); }
    return r.trim();
  }

  // ── REGISTRO ──
  const valor = extractValue(text);
  const catInfo = extractCategory(norm);

  if (valor && catInfo) {
    const obs = extractObs(text, catInfo.cat);
    if (catInfo.cat === 'Outros' && !obs)
      return 'Para "Outros", informe uma observação após um traço.\nEx: "Gastei 150 em outros — taxa extra do condomínio"';

    let cartao_idx = null;
    let cartaoNome = '';

    if (catInfo.tipo === 'cc') {
      cartao_idx = extractCartao(norm, cartoes);
      if (cartao_idx === null) {
        // Monta lista de cartões disponíveis para orientar o usuário
        const nomesCartoes = cartoes.filter(c=>c?.nome).map(c=>c.nome).join(', ');
        return `💳 Em qual cartão foi essa compra?\n\nCartões disponíveis: *${nomesCartoes}*\n\nExemplo: "Gastei ${valor} em ${catInfo.cat.toLowerCase()} no ${cartoes[0]?.nome||'cartão'}"`;
      }
      cartaoNome = cartoes[cartao_idx]?.nome || '';
    }

    const today = new Date().toISOString().split('T')[0];
    await supabase.from('transactions').insert({
      tipo: catInfo.tipo,
      cartao_idx,
      categoria: catInfo.cat,
      data: today,
      descricao: catInfo.cat,
      valor,
      observacao: obs
    });

    let r = `✅ *Registrado!*\n\n📂 ${catInfo.cat}\n💵 ${fmt(valor)}`;
    if (cartaoNome) r += `\n💳 ${cartaoNome}`;
    if (obs) r += `\n📝 ${obs}`;
    return r;
  }

  return `Não entendi. Exemplos:\n\n*Registrar gasto:*\n"Gastei 45 na farmácia no Neon"\n"Uber 22 reais no Santander"\n"Aluguel 800"\n\n*Consultar:*\n"Saldo disponível"\n"Saldo do cartão Neon"\n"Orçamento do mercado"\n"Resumo do mês"`;
}

async function sendTelegram(chatId, message) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown'
  });
}

async function setWebhook() {
  const url = `${RENDER_URL}/webhook`;
  try {
    const res = await axios.post(`${TELEGRAM_API}/setWebhook`, { url, drop_pending_updates: true });
    console.log('Webhook configurado:', res.data);
  } catch(e) {
    console.error('Erro ao configurar webhook:', e.message);
  }
}

function startAutoPing() {
  setInterval(async () => {
    try {
      await axios.get(`${RENDER_URL}/ping`);
      console.log('Auto-ping OK:', new Date().toISOString());
    } catch(e) {
      console.log('Auto-ping falhou:', e.message);
    }
  }, 4 * 60 * 1000);
}

const PORT = process.env.PORT || 10000;
http.createServer(async (req, res) => {

  // Dashboard
  if (req.method === 'GET' && req.url === '/dashboard') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(html);
    } catch(e) {
      res.writeHead(404); res.end('Dashboard não encontrado');
    }
    return;
  }

  // Health check / ping
  if (req.method === 'GET' && (req.url === '/' || req.url === '/ping')) {
    res.writeHead(200); res.end('ok');
    return;
  }

  // Webhook do Telegram
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      console.log('POST /webhook recebido');
      try {
        const update = JSON.parse(body);
        const message = update.message;
        if (message && message.text) {
          const chatId = String(message.chat.id);
          const text = message.text;
          console.log(`Mensagem de ${chatId}: ${text}`);
          if (chatId === MEU_CHAT_ID) {
            const resposta = await processMessage(text);
            await sendTelegram(chatId, resposta);
            console.log('Resposta enviada!');
          }
        }
      } catch(e) {
        console.error('Erro:', e.message);
      }
      res.writeHead(200); res.end('ok');
    });
    return;
  }

  res.writeHead(404); res.end('not found');

}).listen(PORT, async () => {
  console.log(`Servidor HTTP na porta ${PORT}`);
  await setWebhook();
  startAutoPing();
  console.log('Auto-ping iniciado (a cada 4 minutos)');
});
