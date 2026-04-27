require('dotenv').config();
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const MEU_CHAT_ID = String(process.env.MEU_CHAT_ID);
const RENDER_URL = 'https://bot-financeiro-eu35.onrender.com';

const CC_CATS = ['Mercado','Feira','Padaria','Transporte','Lazer','Vestimenta','Eletrônicos','Utensílios para casa','Eletrodomésticos','Móveis','Presentes','Assinaturas','Farmácia','Saúde/Consultas','Restaurantes','Acessórios','Uber','Livros','Manutenção','Outros'];
const FIX_CATS = ['Aluguel','Água','Luz','Internet','Celular','TV','Plano funerário','Empréstimo'];
const CC_KEYWORDS = [
  ['mercado','supermercado'],['feira'],['padaria','cafeteria','cafe'],
  ['transporte','onibus','metro','trem','passagem'],['lazer','cinema','teatro','show'],
  ['vestimenta','roupa','calcado','sapato','tenis'],['eletronico','notebook','tablet'],
  ['utensilio','panela','copo','prato'],['eletrodomestico','geladeira','fogao','microondas'],
  ['movel','sofa','cama','guarda roupa'],['presente'],
  ['assinatura','netflix','spotify','amazon','disney'],
  ['farmacia','remedio','medicamento','comprimido'],
  ['saude','consulta','medico','dentista','exame','hospital','clinica'],
  ['restaurante','lanchonete','pizzaria','pizza','lanche','almoco','jantar'],
  ['acessorio','bolsa','mochila','cinto','relogio','oculos'],
  ['uber','99','cabify','taxi'],['livro','livraria'],
  ['manutencao','conserto','reparo','tecnico','oficina'],['outros','outro']
];
const FIX_KEYWORDS = [
  ['aluguel'],['agua','conta de agua'],['luz','energia'],['internet','wifi'],
  ['plano celular','telefone'],['tv','televisao'],['plano funerario','funeral'],
  ['emprestimo','prestacao','parcela']
];

function normalize(str){ return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' '); }
function extractValue(text){ const m=text.match(/(\d{1,6}[.,]\d{2}|\d{1,6})/); return m?parseFloat(m[1].replace(',','.')):null; }
function extractCategory(norm){
  for(let i=0;i<CC_KEYWORDS.length;i++) for(const kw of CC_KEYWORDS[i]) if(norm.includes(kw)) return {cat:CC_CATS[i],tipo:'cc'};
  for(let i=0;i<FIX_KEYWORDS.length;i++) for(const kw of FIX_KEYWORDS[i]) if(norm.includes(kw)) return {cat:FIX_CATS[i],tipo:'fix'};
  return null;
}
function extractObs(text,cat){ if(cat!=='Outros') return null; const m=text.match(/[-—:]\s*(.+)$/); return m?m[1].trim():null; }

async function getConfig(){
  const {data}=await supabase.from('configuracoes').select('dados').eq('id',1).single();
  return data?.dados||{salario:0,cartoes:[],orcCC:{},orcFix:{}};
}

async function processMessage(text){
  const norm=normalize(text);
  const cfg=await getConfig();
  const mes=new Date().toISOString().slice(0,7);

  if(/saldo|disponivel|quanto.*gastar/.test(norm)){
    const {data}=await supabase.from('transactions').select('valor').gte('data',mes+'-01');
    const total=(data||[]).reduce((s,t)=>s+parseFloat(t.valor),0);
    const saldo=cfg.salario-total;
    return `💰 Saldo disponível: R$ ${saldo.toFixed(2).replace('.',',')}\n\nSalário: R$ ${cfg.salario.toFixed(2).replace('.',',')}\nGasto no mês: R$ ${total.toFixed(2).replace('.',',')}`;
  }

  if(/resumo|relatorio|situacao/.test(norm)){
    const {data}=await supabase.from('transactions').select('valor,tipo,categoria').gte('data',mes+'-01');
    const txns=data||[];
    const cc=txns.filter(t=>t.tipo==='cc').reduce((s,t)=>s+parseFloat(t.valor),0);
    const fix=txns.filter(t=>t.tipo==='fix').reduce((s,t)=>s+parseFloat(t.valor),0);
    const cats=[...CC_CATS,...FIX_CATS];
    const top=cats.map(c=>({c,v:txns.filter(t=>t.categoria===c).reduce((s,t)=>s+parseFloat(t.valor),0)})).filter(x=>x.v>0).sort((a,b)=>b.v-a.v).slice(0,5);
    let r=`📊 Resumo do mês\n\nSalário: R$ ${cfg.salario.toFixed(2).replace('.',',')}\nCartões: R$ ${cc.toFixed(2).replace('.',',')}\nFixos: R$ ${fix.toFixed(2).replace('.',',')}\nSaldo: R$ ${(cfg.salario-cc-fix).toFixed(2).replace('.',',')}`;
    if(top.length){ r+='\n\n🏆 Maiores gastos:\n'; top.forEach(x=>{ r+=`  • ${x.c}: R$ ${x.v.toFixed(2).replace('.',',')}\n`; }); }
    return r.trim();
  }

  const valor=extractValue(text);
  const catInfo=extractCategory(norm);
  if(valor&&catInfo){
    const obs=extractObs(text,catInfo.cat);
    if(catInfo.cat==='Outros'&&!obs) return 'Para "Outros", informe uma observação após um traço.\nEx: "Gastei 150 em outros — taxa extra do condomínio"';
    const today=new Date().toISOString().split('T')[0];
    await supabase.from('transactions').insert({tipo:catInfo.tipo,cartao_idx:catInfo.tipo==='cc'?0:null,categoria:catInfo.cat,data:today,descricao:catInfo.cat,valor,observacao:obs});
    let r=`✅ Registrado!\n\n📂 ${catInfo.cat}\n💵 R$ ${valor.toFixed(2).replace('.',',')}`;
    if(obs) r+=`\n📝 ${obs}`;
    return r;
  }

  return 'Não entendi. Exemplos:\n"Gastei 45 na farmácia"\n"Uber 22 reais"\n"Saldo disponível"\n"Resumo do mês"';
}

async function sendTelegram(chatId, message){
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: message });
}

async function setWebhook(){
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

  // Health check — somente GET /ping ou GET /
  if (req.method === 'GET' && (req.url === '/' || req.url === '/ping')) {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  // Webhook do Telegram — somente POST /webhook
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      console.log('POST /webhook recebido, body:', body.substring(0, 200));
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
            console.log('Resposta enviada com sucesso!');
          } else {
            console.log(`Chat ID ${chatId} não autorizado. Esperado: ${MEU_CHAT_ID}`);
          }
        }
      } catch(e) {
        console.error('Erro ao processar update:', e.message);
      }
      res.writeHead(200);
      res.end('ok');
    });
    return;
  }

  // Qualquer outra rota
  console.log(`Rota não encontrada: ${req.method} ${req.url}`);
  res.writeHead(404);
  res.end('not found');

}).listen(PORT, async () => {
  console.log(`Servidor HTTP na porta ${PORT}`);
  await setWebhook();
  startAutoPing();
  console.log('Auto-ping iniciado (a cada 4 minutos)');
});
