const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const express = require('express');
const app = express();
const { exec } = require('child_process');
const cors = require('cors');

// Middleware para parsing do JSON no corpo da requisição
app.use(express.json());
app.use(cors()); // Permite todas as origens

const port = 44000;

const serverProcesses = [];
let EventsData = [];
let MessagesFilter;

// Carregar filtro de mensagens do arquivo JSON
async function loadMessagesFilter() {
    try {
        // Use fs.promises.readFile ao invés de fs.readFile
        MessagesFilter = await fs.promises.readFile(path.join(__dirname, 'messages_filter.json'), 'utf-8');
        MessagesFilter = JSON.parse(MessagesFilter);  // Se o arquivo for JSON, parseie-o
    } catch (error) {
        console.error('Erro ao carregar o filtro de mensagens:', error);
        throw error;
    }
}

// Copiar a pasta base do servidor para uma nova pasta específica do evento
async function copyServerBase(eventId) {
    try {
        const serverBase = path.join(__dirname, 'acc_server');
        const newServerDir = path.join(__dirname, `${eventId}-server`);

        // Copiar a pasta do servidor base para uma nova pasta com o nome do evento
        await fs.promises.cp(serverBase, newServerDir, { recursive: true });

        return newServerDir;
    } catch (error) {
        console.error(`Erro ao copiar a pasta do servidor para o evento ${eventId}:`, error);
        throw error;  // Para garantir que o processo pare se houver um erro crítico
    }
}

async function updateEventJson(serverDir, sessionDetails) {
    const eventJsonPath = path.join(serverDir, 'cfg', 'event.json');

    // Sobrescrever o arquivo event.json com os detalhes da sessão
    const updatedEventData = JSON.stringify(sessionDetails, null, 2);
    await fs.promises.writeFile(eventJsonPath, updatedEventData, 'utf-8');
}

// Calcular o tempo restante até o início do evento
function calculateStartTime(startDate) {
    const eventStartTime = new Date(startDate).getTime();
    const currentTime = new Date().getTime();
    return eventStartTime - currentTime;
}

// Função para executar o script insert_result_on_db.js
function runInsertResultScript(Event, sessionType) {

    const tempFilePath = path.join(__dirname, 'temp_event.json');

    // Salvar o objeto Event em um arquivo temporário
    fs.writeFileSync(tempFilePath, JSON.stringify(Event));
    
    const command = `node insert_result_on_db.js "${tempFilePath}" ${sessionType}`;

    //console.log(`Executando node insert_result_on_db.js com sessionType: ${sessionType}\nEvent:\n${JSON.stringify(Event)}`);

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Erro ao executar o script: ${error.message}`);
            return;
        }

        if (stderr) {
            console.error(`Erro de execução: ${stderr}`);
            return;
        }

        console.log(`Saída do script: ${stdout}`);
    });
}

// Função para gerenciar o envio de mensagens para a fila
function waitToSendMsg(message, Event) {
    for (const msg_f of MessagesFilter) {
        if (msg_f.type === "ignore") {
            continue;
        }
        else if (msg_f.type === "info" && message.match(new RegExp(msg_f.message))) {
            console.log('Informação adicionada a Event.QueueMsgs, Mensagem: ', message);
            Event.QueueMsgs.push(message);
        }
        else if (msg_f.type === "practice_finish" && message.match(new RegExp(msg_f.message))) {
            console.log(`[${Event.eventId}] Treino Livre Finalizado! Mensagem: `, message);
            runInsertResultScript(Event, 'P');
        }
        else if (msg_f.type === "qualy_finish" && message.match(new RegExp(msg_f.message))) {
            console.log(`[${Event.eventId}] Qualificação Finalizada! Mensagem: `, message);
            runInsertResultScript(Event, 'Q');
        }
        else if (msg_f.type === "race_finish" && message.match(new RegExp(msg_f.message))) {
            console.log(`[${Event.eventId}] Corrida Finalizada! Mensagem: `, message);
            runInsertResultScript(Event, 'R');
        }
    }
}

// Manipular a saída e processá-la linha por linha
function handleOutput(output, Event) {
    const lines = output.split('\n');
    lines.forEach(line => {
        if (line.trim()) {
            waitToSendMsg(line, Event);
        }
    });
}

// Função para iniciar o servidor e capturar a saída
function startServer(serverDir, Event) {
    const exePath = path.join(__dirname, 'acc_server', 'accServer.exe'); // Caminho do executável do servidor
    console.log(`Iniciando servidor do ACC em ${serverDir}`);
    
    const serverProcess = spawn(exePath, { cwd: serverDir }); // Inicie o executável no diretório do evento
    serverProcesses.push(serverProcess);

    // Captura a saída do servidor
    serverProcess.stdout.on('data', (data) => {
        handleOutput(data.toString(), Event);
    });

    serverProcess.stderr.on('data', (data) => {
        handleOutput(data.toString(), Event);
    });

    serverProcess.on('close', (code) => {
        console.log(`Servidor ${Event.eventId} finalizado com código ${code}`);
    });
}

// Função para enviar as mensagens armazenadas na fila para os clientes conectados
function sendMessagesToClient(Event) {
    setInterval(() => {
        if (Event.QueueMsgs.length > 0) {
            const message = Event.QueueMsgs.shift();
            console.log(`[${Event.eventId}]:`, message);

            // Envia a mensagem para todos os clientes conectados
            Event.webSocket_clients.forEach(client => client.write(`data: ${message}\n\n`));
        }
    }, 300); // Intervalo de 300ms
}

// Inicializar o servidor HTTP para gerenciar os clientes WebSocket
function startHttp() {
    app.use(express.static(path.join(__dirname, 'public')));

    // Aqui, você cria uma rota para cada eventId
    function createServerMonitor(Event) {

        console.log('[createServerMonitor] Criando endpoint para monitoramento do evento');

        app.get('/' + Event.eventId, (req, res) => {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();
            Event.webSocket_clients.push(res);
            req.on('close', () => {
                Event.webSocket_clients = Event.webSocket_clients.filter(client => client !== res);
            });
        });
    };

    // Endpoint que recebe dados de um evento
    app.post('/receive_event', (req, res) => {
        try {
            if (req.body) {

                const Event = req.body;

                console.log('[/receive_event] Event: ', JSON.stringify(Event));

                makeEventsData(Event);
                createServerMonitor(Event);
                res.json({ message: '[/receive_event] evento recebido com sucesso' });
            } else {
                res.json({ error: '[/receive_event] erro ao receber os dados do evento, verifique o JSON' });
            }
        }
        catch(err) {
            console.log('[/receive_event] Exception: Erro ao tentar receber os dados do evento.');
        }
        
    });

    // Endpoint que recebe dados de um evento
    app.post('/receive_preset', (req, res) => {
        try {
            if (req.body) {

                const Preset = req.body;
                console.log('[/receive_event] Preset: ', JSON.stringify(Preset));

                res.json({ message: '[/receive_event] preset recebido com sucesso' });
            } else {
                res.json({ error: '[/receive_event] erro ao receber os dados do preset, verifique o JSON' });
            }
        }
        catch(err) {
            console.log('[/receive_event] Exception: Erro ao tentar receber os dados do evento.');
        }
        
    });


    app.listen(port, () => {
        console.log(`[acc-module-server] started on port: ${port}`);
    });
}

// Função para iniciar a preparação dos dados de cada evento
async function makeEventsData(Event) {

    console.log('[makeEventsData] Iniciado! Event: ', JSON.stringify(Event));

    Event.QueueMsgs = []; // Inicializar fila de mensagens para o evento
    Event.webSocket_clients = []; // Inicializar a lista de clientes conectados via WebSocket

    const { eventId, start_date, CfgEventFile } = Event;

    console.log(`eventId: ${eventId} | start_date: ${start_date} | CfgEventFile: ${CfgEventFile}`);

    // 1. Copiar a pasta do servidor base
    const serverDir = await copyServerBase(eventId);

    // 2. Atualizar o arquivo event.json
    await updateEventJson(serverDir, CfgEventFile);

    // 3. Calcular o tempo de início
    const startTime = calculateStartTime(start_date);
    const safetyMargin = 1000;

    if (startTime > safetyMargin) {
        console.log(`Servidor ${eventId} será iniciado em ${startTime / 1000} segundos`);
        setTimeout(() => {
            startServer(serverDir, Event);
            sendMessagesToClient(Event);
        }, startTime);
    } else {
        console.log(`A hora de início do evento ${eventId} já passou. Iniciando o servidor imediatamente.`);
        startServer(serverDir, Event);
        sendMessagesToClient(Event);
    }
}

// Iniciar o script
(async () => {
    await loadMessagesFilter();
    startHttp();
})();