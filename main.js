const apm = require('./apm');
const path = require('path');
const fs = require('fs');
const express = require('express');
const app = express();
const cors = require('cors');
const http = require('http');
const { exec } = require('child_process');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { updateEndpoint } = require('./updateEndpoint');

// Middleware para parsing do JSON no corpo da requisição
app.use(express.json());
app.use(cors()); // Permite todas as origens

const port = 44000;

const serverProcesses = [];
//let EventsData = [];
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

async function updateEventRules(serverDir, EventRules) {
    const EventRulesJsonPath = path.join(serverDir, 'cfg', 'eventRules.json');

    // Sobrescrever arquivo eventRules.json
    const updatedEventRules = JSON.stringify(EventRules, null, 2);
    await fs.promises.writeFile(EventRulesJsonPath, updatedEventRules, 'utf-8');
}

async function updateSettings(serverDir, Settings) {

    console.log(`[updateSettings] Called! | serverDir: ${serverDir} | Settings: ${JSON.stringify(Settings)}`);

    const SettingsJsonPath = path.join(serverDir, 'cfg', 'settings.json');

    console.log(`[updateSettings] Called! | SettingsJsonPath: ${SettingsJsonPath}`);

    // Sobrescrever arquivo Settings.json
    const updatedSettings = JSON.stringify(Settings, null, 2);

    console.log(`[updateSettings] Called! | updatedSettings: ${updatedSettings}`);

    await fs.promises.writeFile(SettingsJsonPath, updatedSettings, 'utf-8');
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

    const command = `node insert_result_on_db.js "${tempFilePath}" ${sessionType} ${etapa_primary_id}`;

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

async function registerDriversOnEntrylist() {
    
    console.log('[registerDriversOnEntrylist] Called!');

    try {

        const API_URL = process.env.API_URL || "http://185.101.104.129:8084";

        // esta api faz uma requisição para fazer um select na tabela acc.piloto_temporada_etapa;
        const [piloto_temporada_etapa] = await Promise.all([
            app.get(`${API_URL}/piloto_temporada_etapa`),
        ]);

        if (!Array.isArray(piloto_temporada_etapa.data)) {
            throw new Error("[registerDriversOnEntrylist] Dados de piloto_temporada_etapa inválidos");
        }

        const EntryListDrivers = {
            "entries": []
        };

        for (let i = 0; i < piloto_temporada_etapa.data.length; i++){

            const Dd = piloto_temporada_etapa.data[i];

            const driver_obj = {
                "drivers": [
                    {
                        "firstName": Dd.nome,
                        "lastName": Dd.sobrenome,
                        "shortName": Dd.nome_curto,
                        "nationality": 17,
                        "driverCategory": 1,
                        "helmetTemplateKey": 503,
                        "helmetBaseColor": 17,
                        "helmetDetailColor": 243,
                        "helmetMaterialType": 0,
                        "helmetGlassColor": 0,
                        "helmetGlassMetallic": 0.0,
                        "glovesTemplateKey": 200,
                        "suitTemplateKey": 504,
                        "suitDetailColor1": 243,
                        "suitDetailColor2": 341,
                        "playerID": Dd.steam_guid,
                        "aiSkill": 100,
                        "aiAggro": 50,
                        "aiRainSkill": 50,
                        "aiConsistency": 50
                    }
                ],
                "customCar": "",
                "raceNumber": Dd.numero_carro,
                "defaultGridPosition": 7,
                "forcedCarModel": -1,
                "overrideDriverInfo": 0,
                "isServerAdmin": 0,
                "overrideCarModelForCustomCar": 1,
                "configVersion": 1
            }

            EntryListDrivers.entries.push(driver_obj);
            
        }

        console.log(`[registerDriversOnEntrylist] entrylist a ser adicionada: EntryListDrivers: ${EntryListDrivers}`);

        const EntrylistJsonPath = path.join(serverDir, 'cfg', 'entrylist.json');

        const updatedEntrylist = JSON.stringify(EntryListDrivers, null, 4);

        await fs.promises.writeFile(EntrylistJsonPath, updatedEntrylist, 'utf-8');
        
    } catch (err) {
        console.error('[registerDriversOnEntrylist] Erro ao tentar inserir pilotos na Entrylist: ', err);
        throw err;
    }
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

async function InsertEventOnDb(Event) {

    console.log(`[InsertEventOnDb] Inserindo Event no banco acc.Etapas...`);

        const config = JSON.parse(fs.readFileSync('./config.json'));

        const client = new Client({
            user: config.cfgs.postgresql.user,
            host: config.cfgs.postgresql.hostaddr,
            database: config.cfgs.postgresql.dbname,
            password: config.cfgs.postgresql.password,
            port: config.cfgs.postgresql.port,
        });
    
    try {
    
        await client.connect();
        await client.query('BEGIN');

        // se esta criando a temporada o id dela não existe ainda, pegar no returning id.
        let temporada_id = -404;

        if (Event.new_temporada && Event.new_temporada.temporada_nome !== "") {
            console.log(`[InsertEventOnDb] Encontrado nova temporada: ${Event.new_temporada.temporada_nome}, adicionando ao banco.`);
            temporada_id = await createTemporada(client, Event.new_temporada);
        } else {
            temporada_id = Event.temporada;
        }

        const resultEtapaInsert = await client.query(`INSERT INTO acc.Etapas (eventId, temporada_id, etapa, stageName, startDate, trackName, carGroup, status, multiplicador_pts_etapa, ambient_temp, cloud_level, rain_percent, weather_randomness, mandatoryPitstopCount, isMandatoryPitstopTyreChangeRequired, isMandatoryPitstopRefuellingRequired, isRefuellingTimeFixed, tyreSetCount, isRefuellingAllowedInRace, etapa_tipo) VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
                    [Event.eventId, temporada_id, Event.etapa, Event.settings.serverName, Event.start_date, Event.CfgEventFile.track, Event.settings.carGroup, 'Em Aberto',
                        Event.multiplicador_pts_etapa, Event.CfgEventFile.ambientTemp, Event.CfgEventFile.cloudLevel, Event.CfgEventFile.rain, Event.CfgEventFile.weatherRandomness,
                        Event.eventRules.mandatoryPitstopCount, Event.eventRules.isMandatoryPitstopTyreChangeRequired, Event.eventRules.isMandatoryPitstopRefuellingRequired,
                        Event.eventRules.isRefuellingTimeFixed, Event.eventRules.tyreSetCount, Event.eventRules.isRefuellingAllowedInRace, Event.etapa_tipo]);
                        
        const etapaId = resultEtapaInsert.rows[0].id;
        if (resultEtapaInsert) {
            console.log(`[InsertEventOnDb] Evento inserido com sucesso em acc.Etapas, id: ${etapaId}`);
        }

        const queryLiveTable = `INSERT INTO acc.Temporada_Etapas_Lives (id_temporada, id_etapa, numero_etapa, live_url) VALUES ($1, $2, $3, $4)`;

        // Inserir a url da live na tabela 'acc.Temporada_Etapas_Lives'
        const resultLiveTable = await client.query(queryLiveTable, [temporada_id, etapaId, Event.etapa, Event.live_url]);
        if(resultLiveTable) {
            console.log(`[InsertEventOnDb] live_url inserida com sucesso em acc.Temporada_Etapas_Lives`);
        }

        //console.log("Tipo e valor dos dados da sessão:");
        //console.log("resultEtapaInsert:", "typeof:", typeof resultEtapaInsert, "valor:", resultEtapaInsert);

        for (session of Event.CfgEventFile.sessions) {
            // console.log("session.sessionType:", "typeof:", typeof session.sessionType, "valor:", session.sessionType);
            // console.log("session.dayOfWeekend:", "typeof:", typeof session.dayOfWeekend, "valor:", session.dayOfWeekend);
            // console.log("session.hourOfDay:", "typeof:", typeof session.hourOfDay, "valor:", session.hourOfDay);
            // console.log("session.sessionDurationMinutes:", "typeof:", typeof session.sessionDurationMinutes, "valor:", session.sessionDurationMinutes);
            // console.log("session.timeMultiplier:", "typeof:", typeof session.timeMultiplier, "valor:", session.timeMultiplier);
            // console.log("session.recompensas_rpo:", "typeof:", typeof session.recompensas_rpo, "valor:", session.recompensas_rpo);
            // inserindo sessões:
            const sessionIdRes = await client.query(
                `INSERT INTO acc.sessoes (etapa_id, sessiontype, dayofweekend, hourofday, sessiondurationminutes, timemultiplier, recompensas_rpo)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [parseInt(etapaId, 10), session.sessionType, parseInt(session.dayOfWeekend, 10), parseInt(session.hourOfDay, 10), parseInt(session.sessionDurationMinutes, 10), parseFloat(session.timeMultiplier), parseInt(session.recompensas_rpo, 10)]
            );

            // inserir dados na tabela relacional 'acc.Temporada_Etapas_Sessoes'
            const session_id = sessionIdRes.rows[0].id;

            const query_Temporada_Etapas_Sessoes = `INSERT INTO acc.Temporada_Etapas_Sessoes (temporada_id, etapa_id, sessao_id) VALUES ($1, $2, $3)`;
            await client.query(query_Temporada_Etapas_Sessoes, [temporada_id, etapaId, session_id]);
        }

        await client.query('COMMIT');
        console.log(`[InsertEventOnDb] Todas as operações concluídas com sucesso.`);

        console.log('Atualizando endpoints do redis:');

        const endpointsToUpdate = [
            'get_eventos',
            'view_temporadas_resultados_practices',
            'view_temporadas_resultados_qualys',
            'view_temporadas_resultados',
            'view_temporadas_resultados_all',
            'piloto_temporada_etapa',
            'view_temporadas_etapas_sessoes',
            'ranking_piloto_temporada',
            'ranking_equipe_temporada'
        ];

        await Promise.all(endpointsToUpdate.map(endpoint => updateEndpoint(endpoint)));
        console.log('[InsertEventOnDb] Todos os endpoints foram atualizados com sucesso.');

        return etapaId;

    } catch (error) {
        await client.query('ROLLBACK'); // Rollback em caso de erro
        console.error('[InsertEventOnDb] Excessão ao tentar inserir: ', error);
        throw error;
    } finally {
        console.log('[InsertEventOnDb] [finally] Processo concluído com sucesso! fechando conexão...');
        await client.end(); // Fechar a conexão
    }
}

async function createTemporada(client, tn) {

    // Primeiro, vamos buscar o maior ID existente
    const maxIdQuery = `SELECT COALESCE(MAX(id), -1) as max_id FROM base.temporadas`;
    const maxIdResult = await client.query(maxIdQuery);
    const newId = maxIdResult.rows[0].max_id + 1;

    const verifySelect = `SELECT nome, id FROM base.temporadas WHERE nome = $1  `;
    const verify_res = await client.query(verifySelect, [tn.temporada_nome]);
    if (verify_res.rows.length > 0) {
        return `[createTemporada] Temporada com o nome ${tn.temporada_nome} já existe.`;
    }
    
    // Query de inserção usando placeholders ($1, $2, etc.)
    const insertQuery = `
        INSERT INTO base.temporadas (id, nome, simulador, data_inicio, data_fim)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id    
    `;

    try {
        // Executar a query de inserção com os valores
        const t_values = [
            newId,
            tn.temporada_nome,
            tn.temporada_simulador,
            tn.temporada_data_inicio.replace('T', ' '),
            tn.temporada_data_fim.replace('T', ' ')
        ];

        console.log(`[createTemporada] Executando client.query com o t_values: ${t_values}\n`);

        const result = await client.query(insertQuery, t_values);

        // Obter o ID retornado
        const temporada_id = result.rows[0]?.id;
        if (temporada_id) {
            console.log(`[createTemporada] Temporada ${temporada_id} criada com sucesso!`);
            return temporada_id;
        }
    } catch (err) {
        console.log("Erro ao criar a temporada: " + err.message);
        return -2;
    }
}

let etapa_primary_id = -1;

async function makeRequest(path) {
    
    return new Promise((resolve, reject) => {
        const options = {
            hostname: '185.101.104.129',
            port: 8083,
            path: path,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        const req = http.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => { responseData += chunk });
            res.on('end', () => {
                console.log(`[UpdateRedisEndpoint] Response for ${path}:`, responseData);
                resolve(responseData);
            });
        });

        req.on('error', (e) => {
            console.error(`[UpdateRedisEndpoint] Erro para ${path}: ${e.message}`);
            reject(e);
        });

        req.end(); // Finaliza a requisição
    });
}

// Inicializar o servidor HTTP para gerenciar os clientes WebSocket
function startHttp() {
    app.use(express.static(path.join(__dirname, 'public')));

    // Função para atualizar o endpoint do redis
    async function UpdateRedisEndpoint() {
        try {
            console.log('[UpdateRedisEndpoint] Realizando update nos endpoints');
    
            // Fazendo requisições para dois endpoints
            await makeRequest('/update_get_eventos');
            await makeRequest('/update_temporadas'); // Substitua com o caminho do seu segundo endpoint
    
            console.log('[UpdateRedisEndpoint] Ambas as requisições foram concluídas');
        } catch (error) {
            console.log('[UpdateRedisEndpoint] Exceção => ', error);
        }
    }

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
    app.post('/receive_event', async (req, res) => {
        try {
            if (req.body) {

                const Event = req.body;

                console.log(`[receive_event] Event: ${JSON.stringify(Event)}\n`);

                etapa_primary_id = await InsertEventOnDb(Event); console.log('passed InsertEventOnDb()');
                if (etapa_primary_id instanceof Error) {
                    throw etapa_primary_id; // Re-throw the error if it's an Error object
                }
                if (typeof etapa_primary_id !== 'number' || isNaN(etapa_primary_id)) {
                    throw new Error('InsertEventOnDb falhou em retornar um ID válido');
                }
                await UpdateRedisEndpoint(); console.log('passed UpdateRedisEndpoint()');
                await makeEventsData(Event); console.log('passed makeEventsData()');
                createServerMonitor(Event); console.log('passed createServerMonitor()');
                res.json({ message: '[/receive_event] evento recebido com sucesso', etapa_primary_id: etapa_primary_id });
            } else {
                res.json({ error: '[/receive_event] erro ao receber os dados do evento, verifique o JSON' });
            }
        }
        catch (err) {
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

    const { eventId, start_date, CfgEventFile, eventRules, settings } = Event;

    console.log(`\n----> Event Data: ${JSON.stringify(
          { eventId, start_date, CfgEventFile, eventRules, settings },
          null, 2
        )}`
    );

    // 1. Copiar a pasta do servidor base
    const serverDir = await copyServerBase(eventId);

    // 2. Atualizar o arquivo event.json
    await updateEventJson(serverDir, CfgEventFile);

    // 3. Atualizar o arquivo eventRules.json
    await updateEventRules(serverDir, eventRules);

    // 4. Atualizar o arquivo settings.json
    await updateSettings(serverDir, settings);

    // 5. Calcular o tempo de início
    const startTime = calculateStartTime(start_date);
    const safetyMargin = 1000;

    if (startTime > safetyMargin) {
        console.log(`Servidor ${eventId} será iniciado em ${startTime / 1000} segundos`);
        setTimeout( async () => {
            await registerDriversOnEntrylist();
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