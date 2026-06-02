# 🚀 Deploy do Relay — Colaboração entre dispositivos

Escolha UMA das opções abaixo.

---

## ✅ Opção A — Render (recomendada, 5 minutos)

### 1. Crie um repositório no GitHub

1. Acesse https://github.com/new
2. Nome: `planner-relay` (público)
3. Clicar em **Create repository**

### 2. Suba os arquivos

No terminal do seu PC:
```bash
cd C:\Users\luk23\Downloads\PLANNER

git init
git add server-relay.js package.json render.yaml
git commit -m "relay server"
git remote add origin https://github.com/SEU_USUARIO/planner-relay.git
git branch -M main
git push -u origin main
```

> Substitua `SEU_USUARIO` pelo seu nome do GitHub.

### 3. Deploy no Render

1. Acesse https://dashboard.render.com
2. Crie conta (Google ou GitHub)
3. Clique **New +** → **Web Service**
4. Conecte seu GitHub e escolha `planner-relay`
5. Preencha:
   - **Name**: `planner-relay`
   - **Runtime**: `Node`
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free**
6. Clique **Create Web Service**
7. Aguarde ~2 min. Quando aparecer **Live**, copie a URL:
   ```
   https://planner-relay.onrender.com
   ```

### 4. Configure no Planner

1. Abra o planner em **todos os dispositivos**
2. Clique **⚙ Configurações**
3. Cole a URL do Render (ex: `https://planner-relay.onrender.com`)
4. Clique **Salvar**
5. Clique **👥 Colaborar**

Pronto! ✅

---

## ✅ Opção B — Replit (sem instalar nada)

1. Acesse https://replit.com
2. Crie conta (Google ou GitHub)
3. Clique **Create Repl** → escolha **Node.js**
4. Delete o `index.js` padrão
5. Abra `server-relay.js` no Bloco de Notas, copie TUDO, cole no Replit
6. Clique **Run** (ou Ctrl+Enter)
7. Copie a URL que aparece (ex: `https://nomedoseurepl.replit.app`)
8. Cole no **⚙ Configurações** do planner e ative **👥 Colaborar**

---

## ✅ Opção C — Rede local (mais rápido, mesmo WiFi)

```bash
cd C:\Users\luk23\Downloads\PLANNER
npm install
npm start
```

Aparecerá: `ws://192.168.x.x:3000` — cole no **⚙ Configurações** de cada dispositivo.

> Todos precisam estar na mesma rede WiFi. PC servidor precisa manter o terminal aberto.

---

## 🔄 Reconexão automática

O planner já reconecta sozinho se o relay cair. No Render free, o servidor "dorme" após 15 min de inatividade. Na primeira conexão após dormir, aguarde ~30 segundos.
