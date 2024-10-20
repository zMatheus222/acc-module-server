const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const express = require('express');
const app = express();

const port = 44000;
let webSocket_clients = [];
const QueueMsgs = [];
let MessagesFilter = [];

function loadMessagesFilter() {
    const messages_path = path.join(__dirname, 'messages_filter.json');

    fs.readFile(messages_path, 'utf8', (err, data) => {
        if (err){
            console.error('[loadMessagesFilter] Erro ao ler o arquivo:', err);
            return;
        }
        
        try {
            MessagesFilter = JSON.parse(data);
        } catch(parseError) {
            console.error('Erro ao parsear o JSON:', parseError);
        }
    });
}

function loadArgs() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log('Insira pelo menos 2 argumentos (leia Arguments.md)');
        process.exit(1);
    }

    const base_info = JSON.parse(args[0]);
    const sessions = JSON.parse(args[1]);

    //console.log('base_info: ', base_info, '\nsessions: ', sessions);

    const eventFilePath = path.join(__dirname, 'acc_server', 'cfg', 'event.json');
    fs.writeFileSync(eventFilePath, JSON.stringify(sessions, null, 4), 'utf8');
    console.log(`Arquivo ${eventFilePath} sobrescrito com sucesso!`);
}

function startServer() {
    const exePath = path.join(__dirname, 'acc_server', 'accServer.exe');

    console.log('Inicializando servidor do ACC!');
    const child = spawn(exePath, { cwd: path.dirname(exePath) });

    child.stdout.on('data', data => {
        //console.log(`stdout:\n${data}`);
        handleOutput(data.toString());
    });

    child.stderr.on('data', data => {
        //console.error(`stderr: ${data}`);
        handleOutput(data.toString());
    });

    child.on('error', (error) => {
        //console.error(`error: ${error.message}`);
    });

    child.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        waitToSendMsg(`Servidor encerrado com o código ${code}`);
    });
}

function handleOutput(output) {
    // Divide a saída em linhas e insere cada linha na fila
    const lines = output.split('\n');
    lines.forEach(line => {
        if (line.trim()) { // Ignora linhas vazias
            waitToSendMsg(line); // Insere na fila para envio
        }
    });
}

function waitToSendMsg(message) {

    // console.log('Inserindo mensagem a QueueMsgs');

    // comparar mensagem com lista de mensagens do arquivo messages_filter.json
    for (msg_f of MessagesFilter) {
        if (msg_f.type === "ignore") {
            continue;
        }
        else if (msg_f.type === "info" && message.match(new RegExp(msg_f.message))) {
            console.log('Informação adicionada a QueueMsgs, Mensagem: ', message);
            QueueMsgs.push(message);
        }
        else if (msg_f.type === "practice_finish" && message.match(new RegExp(msg_f.message))) {
            console.log('Treino Livre Finalizado! Mensagem: ', message);
            // pegar o resultado do qualy e inserir no banco de dados
        }
        else if (msg_f.type === "qualy_finish" && message.match(new RegExp(msg_f.message))) {
            console.log('Qualificação Finalizada! Mensagem: ', message);
            // pegar o resultado do qualy e inserir no banco de dados
        }
        else if (msg_f.type === "race_finish" && message.match(new RegExp(msg_f.message))){
            console.log('Corrida Finalizada! Mensagem: ', message);
            // pegar o resultado da corrida e inserir no banco de dados
        }

    }
}

function sendMessagesToClient() {
    setInterval(() => {
        if (QueueMsgs.length > 0) {
            const message = QueueMsgs.shift(); // Pega a primeira mensagem da fila
            console.log('Enviando mensagem:', message);

            // Envia a mensagem para todos os clientes conectados
            webSocket_clients.forEach(client => client.write(`data: ${message}\n\n`));
        }
        // Não faz nada quando não há mensagens, apenas continua o loop
    }, 300); // Intervalo de 100ms para verificar a fila e enviar mensagens
}

function startHttp() {
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });

    app.get('/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        webSocket_clients.push(res); // Adiciona o cliente à lista
        req.on('close', () => {
            webSocket_clients = webSocket_clients.filter(client => client !== res);
        });
    });
    
    app.listen(port, () => {
        console.log(`[acc-module-server] started on port: ${port}`);
    });
}

try {
    loadArgs();
    loadMessagesFilter();
    startServer();
    startHttp();
    sendMessagesToClient();
} catch (err) {
    console.log('Erro de execução: ', err);
}
