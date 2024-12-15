//const apm = require('./apm');
const path = require('path');
const fs = require('fs');
const express = require('express');
const app = express();
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const { exec, execSync } = require('child_process');
const { spawn } = require('child_process');
const { Client } = require('pg');
const { updateEndpointsWithDelay } = require('./updateEndpoint');
const { sendTrace } = require('./EasyTraceFunction');

// Middleware para parsing do JSON no corpo da requisição
app.use(express.json());
app.use(cors()); // Permite todas as origens

const port = 44000;
const config = JSON.parse(fs.readFileSync('./config.json'));

const serverProcesses = new Map();
let MessagesFilter;

const eventTimeouts = new Map();

function cancelEventTimeout(eventId) {
    const timeoutId = eventTimeouts.get(eventId);
    if (timeoutId) {
        clearTimeout(timeoutId);
        eventTimeouts.delete(eventId);
        console.log(`[cancelEventTimeout] Timeout cancelado para o evento ${eventId}`);
    } else {
        console.log(`[cancelEventTimeout] Nenhum timeout encontrado para o evento ${eventId}`);
    }
}

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



    // garantir valores necessários como number
    // CfgEventFile: {
    //     ambientTemp: 17,
    //     cloudLevel: 0.0,
    //     configVersion: 1,
    //     isFixedConditionQualification: 0,
    //     postQualySeconds: 90,
    //     postRaceSeconds: 90,
    //     preRaceWaitingTimeSeconds: 90,
    //     rain: 0,
    //     sessionOverTimeSeconds: 90,
    //     sessions: [
    //         { dayOfWeekend: 3, hourOfDay: 13, sessionDurationMinutes: 3, sessionType: "P", timeMultiplier: 1, recompensas_rpo: 3 },
    //         { dayOfWeekend: 3, hourOfDay: 14, sessionDurationMinutes: 3, sessionType: "Q", timeMultiplier: 1, recompensas_rpo: 5 },
    //         { dayOfWeekend: 3, hourOfDay: 15, sessionDurationMinutes: 3, sessionType: "R", timeMultiplier: 1, recompensas_rpo: 7 },
    //     ],
    //     simracerWeatherConditions: 0,
    //     track: "monza",
    //     trackTemp: 20,
    //     weatherRandomness: 1
    // },

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


// Esta função permite agendar callbacks para serem executados após longos períodos,
// superando a limitação de 32 bits do setTimeout padrão.
function setLongTimeout(callback, delay, eventId) {
    // Define o máximo delay seguro (aproximadamente 24.8 dias em milissegundos)
    // que pode ser usado com setTimeout sem causar overflow.
    const max32BitDelay = 2147483647;

    // Verifica se o delay solicitado é maior que o máximo seguro
    function scheduleTimeout(remainingDelay) {
        if (remainingDelay > max32BitDelay) {
            // Se for maior, agenda um timeout para o máximo permitido
            const timeoutId = setTimeout(() => {
                // Quando este timeout for acionado, a função chama a si mesma recursivamente
                // com o delay restante (delay original menos o máximo já aguardado)
                scheduleTimeout(remainingDelay - max32BitDelay);
            }, max32BitDelay);
            eventTimeouts.set(eventId, timeoutId);
        } else {
            // Se o delay for menor ou igual ao máximo seguro,
            // simplesmente agenda o callback com o delay restante
            const timeoutId = setTimeout(() => {
                callback();
                eventTimeouts.delete(eventId);
            }, remainingDelay);
            
            eventTimeouts.set(eventId, timeoutId);
        }
    }

    scheduleTimeout(delay);
}

function stopServer(eventId) {
    console.log(`[stopServer] Tentando fechar processo do eventId: ${eventId}`);

    const process = serverProcesses.get(eventId);
    if (process) {
        console.log(`[stopServer] Processo encontrado para eventId: ${eventId}. Enviando sinal SIGKILL.`);
        process.kill('SIGKILL');
        
        console.log(`[stopServer] Sinal SIGKILL enviado. Removendo processo do Map.`);
        serverProcesses.delete(eventId);
        
        console.log(`[stopServer] Processo removido do Map para eventId: ${eventId}`);
    } else {
        console.log(`[stopServer] Nenhum processo encontrado para eventId: ${eventId}`);
    }

    console.log(`[stopServer] Operação de fechamento concluída para eventId: ${eventId}`);
}

// Função para executar o script insert_result_on_db.js
function runInsertResultScript(Event, sessionType, sessionIndex) {
    console.log('[runInsertResultScript] Iniciando...');

    const tempFilePath = path.join(__dirname, `temp_event-${Event.eventId}.json`);
    console.log(`[runInsertResultScript] Caminho do arquivo temporário: ${tempFilePath}`);

    try {
        // Salvar o objeto Event em um arquivo temporário
        fs.writeFileSync(tempFilePath, JSON.stringify(Event));
        console.log('[runInsertResultScript] Arquivo temporário criado com sucesso');

        const command = `node insert_result_on_db.js "${tempFilePath}" ${sessionType} ${etapa_primary_id}`;
        console.log(`[runInsertResultScript] Executando comando: ${command}`);

        const output = execSync(command, { encoding: 'utf-8' });
        console.log(`[runInsertResultScript] Saída do script:\n${output}`);
    } catch (error) {
        console.error(`[runInsertResultScript] Erro: ${error.message}`);
        console.error(`[runInsertResultScript] Stack: ${error.stack}`);
    } finally {
        // Limpar o arquivo temporário
        try {
            fs.unlinkSync(tempFilePath);
            console.log('[runInsertResultScript] Arquivo temporário removido');

            // descobrir se é a ultima sessão para finalizar o servidor independente da ultima sessão ser corrida, qualy treino etc.
            if(Event.CfgEventFile.lastSessionIndex === sessionIndex) {
                console.log(`[runInsertResultScript] Última sessão concluída. Finalizando o servidor.`);
                stopServer(Event.eventId);
            }

        } catch (unlinkError) {
            console.error(`[runInsertResultScript] Erro ao remover arquivo temporário: ${unlinkError.message}`);
        }
    }

    console.log('[runInsertResultScript] Finalizado');
}

// Função para gerenciar o envio de mensagens para a fila
function waitToSendMsg(message, Event) {
    
    for (const msg_f of MessagesFilter) {
        if (msg_f.type === "ignore") {
            continue;
        }
        else if (msg_f.type === "info" && message.match(new RegExp(msg_f.message))) {
            console.log('[waitToSendMsg] Informação adicionada a Event.QueueMsgs, Mensagem: ', message);
            Event.QueueMsgs.push(message);
        }
        else if (msg_f.type === "practice_finish" && message.match(new RegExp(msg_f.message))) {
            console.log(`[waitToSendMsg] [${Event.eventId}] Treino Livre Finalizado! Mensagem: `, message);
            const sessionIndex = Event.CfgEventFile.sessions.findIndex(session => session.sessionType === "P");
            runInsertResultScript(Event, 'P', sessionIndex);
        }
        else if (msg_f.type === "qualy_finish" && message.match(new RegExp(msg_f.message))) {
            console.log(`[waitToSendMsg] [${Event.eventId}] Qualificação Finalizada! Mensagem: `, message);
            const sessionIndex = Event.CfgEventFile.sessions.findIndex(session => session.sessionType === "Q");
            runInsertResultScript(Event, 'Q', sessionIndex);
        }
        else if (msg_f.type === "race_finish" && message.match(new RegExp(msg_f.message))) {
            console.log(`[waitToSendMsg] [${Event.eventId}] Corrida Finalizada! Mensagem: `, message);
            const sessionIndex = Event.CfgEventFile.sessions.findIndex(session => session.sessionType === "R");
            runInsertResultScript(Event, 'R', sessionIndex);
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

async function registerDriversOnEntrylist(serverDir, Event) {
    
    console.log('[registerDriversOnEntrylist] Called!');

    try {

        if (!Event.etapa_primary_id) {
            throw new Error("[registerDriversOnEntrylist] Event.etapa_primary_id is not defined");
        }

        const API_URL = process.env.API_URL || "http://185.101.104.129:8084";
        console.log(`[registerDriversOnEntrylist] Fetching data from: ${API_URL}/piloto_temporada_etapa`);

        // esta api faz uma requisição para fazer um select na tabela acc.piloto_temporada_etapa;
        const response = await axios.get(`${API_URL}/piloto_temporada_etapa`);

        console.log('[registerDriversOnEntrylist] API Response status:', response.status);
        console.log('[registerDriversOnEntrylist] API Response data:', response.data);
        if (!response.data || !Array.isArray(response.data)) {
            throw new Error("[registerDriversOnEntrylist] Invalid data received from API");
        }

        const filteredData = response.data.filter(Dd => Dd.etapa_id === Event.etapa_primary_id);
        console.log(`[registerDriversOnEntrylist] Filtered ${filteredData.length} entries for etapa_id: ${Event.etapa_primary_id}`);

        const EntryListDrivers = {
            "entries": filteredData.map(Dd => ({
                "drivers": [{
                    "firstName": Dd.nome,
                    "lastName": Dd.sobrenome,
                    "shortName": Dd.nome_curto,
                    "nationality": 17, // You might want to map this based on Dd.nacionalidade
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
                }],
                "customCar": "",
                "raceNumber": Dd.numero_carro,
                "defaultGridPosition": 7,
                "forcedCarModel": -1,
                "overrideDriverInfo": 0,
                "isServerAdmin": 0,
                "overrideCarModelForCustomCar": 1,
                "configVersion": 1
            }))
        };

        console.log(`[registerDriversOnEntrylist] entrylist a ser adicionada:`, JSON.stringify(EntryListDrivers, null, 4));

        const EntrylistJsonPath = path.join(serverDir, 'cfg', 'entrylist.json');

        await fs.promises.writeFile(EntrylistJsonPath, JSON.stringify(EntryListDrivers, null, 4), 'utf-8');

        console.log('[registerDriversOnEntrylist] Entrylist updated successfully');
        
    } catch (err) {
        console.error('[registerDriversOnEntrylist] Erro ao tentar inserir pilotos na Entrylist:', err.message);
        console.error('[registerDriversOnEntrylist] Error stack:', err.stack);
        throw err;
    }
}

// Função para iniciar o servidor e capturar a saída
function startServer(serverDir, Event) {

    const exePath = path.join(__dirname, 'acc_server', 'accServer.exe'); // Caminho do executável do servidor
    console.log(`Iniciando servidor do ACC em ${serverDir}`);

    const serverProcess = spawn(exePath, { cwd: serverDir }); // Inicie o executável no diretório do evento
    serverProcesses.set(Event.eventId, serverProcess); // Se o eventId não existe, cria um novo array

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
    
    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_event_on_db_called", "1.3", "success", "[InsertEventOnDb] Inserindo Event no banco acc.Etapas...");

    console.log(`[InsertEventOnDb] Inserindo Event no banco acc.Etapas...`);

    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_created_config", "1.4", "success", "Criada variavel const config");

    const client = new Client({
        user: config.cfgs.postgresql.user,
        host: config.cfgs.postgresql.hostaddr,
        database: config.cfgs.postgresql.dbname,
        password: config.cfgs.postgresql.password,
        port: config.cfgs.postgresql.port,
    });
    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_created_pg_client", "1.5", "success", "Criado cliente postgresql");
    
    let errorMsg = "none";

    try {
    
        await client.connect();
        await client.query('BEGIN'); //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_client_connected_begin", "1.6", "success", "Conectado com client.connect e query BEGIN iniciado");

        // se esta criando a temporada o id dela não existe ainda, pegar no returning id.
        let temporada_id = -404;

        if (Event.new_temporada && Event.new_temporada.temporada_nome !== "") { //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_nova_temporada_encontrada", "1.7", "success", `[InsertEventOnDb] Encontrado nova temporada: ${Event.new_temporada.temporada_nome}, adicionando ao banco.`);
            console.log(`[InsertEventOnDb] Encontrado nova temporada: ${Event.new_temporada.temporada_nome}, adicionando ao banco.`);
            temporada_id = await createTemporada(client, Event.new_temporada);
        } else {                                                                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_nova_temporada_encontrada", "1.7", "success", `[InsertEventOnDb] Não foi encontrada uma nova temporada, prosseguindo...`);
            temporada_id = Event.temporada;
        }

        const resultEtapaInsert = await client.query(`INSERT INTO acc.Etapas (eventId, temporada_id, etapa, stageName, startDate, trackName, carGroup, status, multiplicador_pts_etapa, ambient_temp, cloud_level, rain_percent, weather_randomness, mandatoryPitstopCount, isMandatoryPitstopTyreChangeRequired, isMandatoryPitstopRefuellingRequired, isRefuellingTimeFixed, tyreSetCount, isRefuellingAllowedInRace, etapa_tipo) VALUES
                ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) RETURNING id`,
                    [Event.eventId, temporada_id, Event.etapa, Event.settings.serverName, Event.start_date, Event.CfgEventFile.track, Event.settings.carGroup, 'Em Aberto',
                        Event.multiplicador_pts_etapa, Event.CfgEventFile.ambientTemp, Event.CfgEventFile.cloudLevel, Event.CfgEventFile.rain, Event.CfgEventFile.weatherRandomness,
                        Event.eventRules.mandatoryPitstopCount, Event.eventRules.isMandatoryPitstopTyreChangeRequired, Event.eventRules.isMandatoryPitstopRefuellingRequired,
                        Event.eventRules.isRefuellingTimeFixed, Event.eventRules.tyreSetCount, Event.eventRules.isRefuellingAllowedInRace, Event.etapa_tipo]);
                
        //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_insert_montado", "1.8", "success", `resultEtapaInsert Executada`);
                        
        const etapaId = resultEtapaInsert.rows[0].id;
        if (resultEtapaInsert) {
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_resultEtapaInsert_ok", "1.9", "success", `[InsertEventOnDb] Evento inserido com sucesso em acc.Etapas, id: ${etapaId}`);
            console.log(`[InsertEventOnDb] Evento inserido com sucesso em acc.Etapas, id: ${etapaId}`);
        } else {
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_resultEtapaInsert_ok", "1.9", "error", `[InsertEventOnDb] Erro ao tentar executar resultEtapaInsert`);
        }

        const queryLiveTable = `INSERT INTO acc.Temporada_Etapas_Lives (id_temporada, id_etapa, numero_etapa, live_url) VALUES ($1, $2, $3, $4)`;

        // Inserir a url da live na tabela 'acc.Temporada_Etapas_Lives'
        const resultLiveTable = await client.query(queryLiveTable, [temporada_id, etapaId, Event.etapa, Event.live_url]);
        if(resultLiveTable) {
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_resultLiveTable", "2.0", "success", `[InsertEventOnDb] INSERT INTO acc.Temporada_Etapas_Lives executado com sucesso.`);
            console.log(`[InsertEventOnDb] live_url inserida com sucesso em acc.Temporada_Etapas_Lives`);
        } else {
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_resultLiveTable", "2.0", "error", `[InsertEventOnDb] Erro ao executar INSERT INTO acc.Temporada_Etapas_Lives.`);
        }

        for (session of Event.CfgEventFile.sessions) {
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

        //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_for_acc_sessoes", "2.1", "success", `[InsertEventOnDb] for INSERT INTO acc.sessoes executado com sucesso.`);

        await client.query('COMMIT');
        console.log(`[InsertEventOnDb] Todas as operações concluídas com sucesso.`);

        //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_commit_ok", "2.2", "success", `[InsertEventOnDb] COMMIT success.`);

        console.log('Atualizando endpoints do redis:');

        const endpointsToUpdate = [
            'get_eventos',
            'view_temporadas_resultados_practices',
            'view_temporadas_resultados_qualys',
            'view_temporadas_resultados',
            'view_temporadas_resultados_all',
            'piloto_temporada_etapa',
            'ranking_piloto_temporada',
            'ranking_equipe_temporada'
        ];

        await updateEndpointsWithDelay(endpointsToUpdate);
        console.log('[InsertEventOnDb] Todos os endpoints foram atualizados com sucesso.');
        
        //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_update_endpoints", "2.3", "success", `[InsertEventOnDb] Todos os endpoints foram atualizados com sucesso. returning etapaId: ${etapaId}`);

        return etapaId;

    } catch (error) {
        await client.query('ROLLBACK'); // Rollback em caso de erro
        console.error('[InsertEventOnDb] Excessão ao tentar inserir: ', error);
        errorMsg = error.message;
        throw error;
    } finally {
        console.log('[InsertEventOnDb] [finally] Processo concluído com sucesso! fechando conexão...');
        await client.end(); // Fechar a conexão
        if(errorMsg === "none") {
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_catch", "2.4", "success", '[InsertEventOnDb] [finally] Processo concluído com sucesso! Conexão fechada.');
        } else {
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_insert_catch", "2.4", "error", `[InsertEventOnDb] [finally] Processo concluído com erro: ${errorMsg}`);
        }
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

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Inicializar o servidor HTTP para gerenciar os clientes WebSocket
function startHttp() {
    app.use(express.static(path.join(__dirname, 'public')));

    // Função para atualizar o endpoint do redis
    async function UpdateRedisEndpoint() {
        
        //await sendTrace("AccModuleServer-ReceiveEvent", "backend_started_updates", "2.7", "success", `[UpdateRedisEndpoint] Called!`);

        try {
            console.log('[UpdateRedisEndpoint] Realizando update nos endpoints');
    
            // Fazendo requisições para dois endpoints
            await makeRequest('/update_get_eventos');
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_updated_get_eventos", "2.8", "success", `[UpdateRedisEndpoint] updated: update_get_eventos`);

            await makeRequest('/update_temporadas'); // Substitua com o caminho do seu segundo endpoint
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_updated_temporadas", "2.9", "success", `[UpdateRedisEndpoint] updated: update_temporadas`);
            
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

        let errorMsg = "none";

        try {
            
            //await sendTrace("AccModuleServer-ReceiveEvent", "backend_first_received", "1.1", "success", "Requisição Recebida no acc-module-server!");

            if (req.body) {
                
                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_reqbody_if", "1.2", "success", "Req.body ok");

                const Event = req.body;

                console.log(`[receive_event] Event recebido: `, Event);

                etapa_primary_id = await InsertEventOnDb(Event); console.log('[/receive_event] passed InsertEventOnDb()');
                
                if (etapa_primary_id instanceof Error) {
                    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_etapa_primary_id", "2.5", "error", `[/receive_event] Erro ao tentar coletar etapa_primary_id: ${etapa_primary_id.message}`);
                    throw etapa_primary_id; // Re-throw the error if it's an Error object
                }
                if (typeof etapa_primary_id !== 'number' || isNaN(etapa_primary_id)) {
                    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_etapa_primary_id", "2.5", "error", `[/receive_event] Erro ao tentar coletar etapa_primary_id: ${etapa_primary_id}`);
                    throw new Error('InsertEventOnDb falhou em retornar um ID válido');
                } else {
                    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_etapa_primary_id", "2.5", "success", `[/receive_event] InsertEventOnDb Success! etapa_primary_id: ${etapa_primary_id}`);
                }

                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_calling_updates", "2.6", "success", `[/receive_event] Calling await UpdateRedisEndpoint()`);

                await UpdateRedisEndpoint(); console.log('[/receive_event] passed UpdateRedisEndpoint()');
                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_updated_temporadas", "3.0", "success", `[/receive_event] Success on: UpdateRedisEndpoint()`);

                await makeEventsData(Event); console.log('[/receive_event] passed makeEventsData()');
                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_finished", "3.9", "success", `[makeEventsData] Finalizado`);
                
                createServerMonitor(Event); console.log('[/receive_event] passed createServerMonitor()');

                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_server_monitor_finished", "4.0", "success", `[makeEventsData] createServerMonitor ended.`);

                res.json({ message: '[/receive_event] evento recebido com sucesso', etapa_primary_id: etapa_primary_id });
            } else {
                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_reqbody_if", "1.2", "error", "[/receive_event] erro ao receber os dados do evento, verifique o JSON");
                res.json({ error: '[/receive_event] erro ao receber os dados do evento, verifique o JSON' });
            }
        }
        catch (err) {
            errorMsg = err.message;
            console.log('[/receive_event] Exception: erro ao tentar receber os dados do evento.');
        }
        finally {
            if (errorMsg === "none") {
                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_server_finished", "4.1", "success", `[makeEventsData] Finished without errors`);
            } else {
                //await sendTrace("AccModuleServer-ReceiveEvent", "backend_server_finished", "4.1", "error", `[makeEventsData] catch error`);
            }
        }

    });

    app.post('/remove_event', async (req, res) => {
        
        let errorMsg = "none";
    
        try {
            if (req.body && req.body.eventid) {
                const eventid = req.body.eventid;
                console.log(`[remove_event] 1.1 Removendo eventid: ${eventid}`);
    
                const client = new Client({
                    user: config.cfgs.postgresql.user,
                    host: config.cfgs.postgresql.hostaddr,
                    database: config.cfgs.postgresql.dbname,
                    password: config.cfgs.postgresql.password,
                    port: config.cfgs.postgresql.port,
                });
    
                await client.connect();

                console.log('[remove_event] 1.2 conectado ao banco postgresql, realizando queries');
    
                try {

                    // verificar se existe resultline na sessão (para não remover)

                    console.log('[remove_event] 1.3 Query: SELECT rli.id FROM acc.resultline... para verificar se há resultados neste eventid...');

                    const result = await client.query(`
                        SELECT
                            rli.id
                        FROM
                            acc.resultline rli
                        INNER JOIN acc.sessoes ss ON rli.id_sessao = ss.id
                        INNER JOIN acc.etapas et ON ss.etapa_id = et.id
                        WHERE et.eventid = $1;
                    `, [eventid]);

                    console.log(`[/remove_event] 1.3 result.rows length [${result.rows.length}] : `, result.rows);

                    if (result.rows.length > 0) {
                        console.log(`[/remove_event] 1.4 Existem linhas de resultado (resultlines) nesta etapa, não é possível remove-la.`);
                        return res.status(409).json({ error: `[/remove_event] Existem linhas de resultado (resultlines) nesta etapa, não é possível removê-la.` });
                    } else {
                        console.log('[remove_event] 1.4 Não existem linhas de resultado, prosseguindo...');
                    }

                    await client.query('BEGIN');

                    // Delete from temporada_etapas_lives
                    await client.query(`
                        DELETE FROM acc.temporada_etapas_lives
                        WHERE id_etapa IN (
                            SELECT id FROM acc.etapas WHERE eventid = $1
                        );
                    `, [eventid]);

                    // Delete from temporada_etapas_sessoes
                    await client.query(`
                        DELETE FROM acc.temporada_etapas_sessoes
                        WHERE etapa_id IN (
                            SELECT id FROM acc.etapas WHERE eventid = $1
                        );
                    `, [eventid]);
    
                    // Delete sessoes
                    await client.query(`
                        DELETE FROM acc.sessoes
                        WHERE etapa_id IN (
                            SELECT id FROM acc.etapas WHERE eventid = $1
                        );
                    `, [eventid]);

                    // Delete etapas
                    await client.query(`
                        DELETE FROM acc.etapas
                        WHERE eventid = $1;
                    `, [eventid]);
    
                    await client.query('COMMIT');

                    console.log(`[remove_event] 1.5 COMMIT das queries realizado com sucesso. executando "cancelEventTimeout(${eventid}) "`);
                    cancelEventTimeout(eventid);
                    
                    console.log(`[remove_event] 1.6 executando "stopServer(${eventid}) "`);
                    stopServer(eventid);

                    await delay(3000);

                    const endpointsToUpdate = [
                        'piloto_temporada_etapa',
                        'get_eventos',
                    ];
                    
                    console.log(`[remove_event] 1.7 Realizando "updateEndpointsWithDelay(${endpointsToUpdate})"`);
                    await updateEndpointsWithDelay(endpointsToUpdate);

                    console.log('[/remove_event] 1.8 Todos os endpoints foram atualizados com sucesso.');
    
                    res.json({ message: `[/remove_event] 1.9 evento removido com sucesso`, eventid: eventid });

                } catch (dbError) {
                    await client.query('ROLLBACK');
                    throw dbError;
                } finally {
                    await client.end();
                }
            } else {
                res.status(400).json({ error: `[/remove_event] erro ao remover evento, eventid não fornecido no corpo da requisição` });
            }
        } catch (err) {
            errorMsg = err.message;
            console.error('[/remove_event] Exception:', errorMsg);
            res.status(500).json({ error: `[/remove_event] erro ao tentar remover evento: ${errorMsg}` });
        }
    });

    app.listen(port, () => {
        console.log(`[acc-module-server] started on port: ${port}`);
    });
}

async function setConfiguration(serverDir) {

    try {

        console.log(`[setConfiguration] Iniciado!`);
            
        // 2. Verificar quantos processos já estão rodando
        // 3. Com base nisso usar a porta abaixo como inicio + o length de processos
        // 4. Inserir portToUse no configuration.json "udpPort": 9601, "tcpPort": 9601,
        // 5. verificar o ponto onde portToUse será pego, provavelmente antes de cada servidor iniciar e a contagem de serverProcesses aumentar

        // porta inicial + tamanho ou seja, quantos processos já estão rodando.
        const portToUse = 9601 + serverProcesses.size;

        console.log(`[setConfiguration] Definindo porta do serverDir: ${serverDir} como: ${portToUse}`);

        // Criando objeto para inserir no arquivo
        const UpdatedConfiguration = {
            "udpPort": portToUse,
            "tcpPort": portToUse,
            "maxConnections": 85,
            "lanDiscovery": 1,
            "registerToLobby": 1,
            "configVersion": 1
        }

        const ConfigurationJsonPath = path.join(serverDir, 'cfg', 'configuration.json');

        await fs.promises.writeFile(ConfigurationJsonPath, JSON.stringify(UpdatedConfiguration, null, 4), 'utf-8');
        console.log(`[setConfiguration] Configuration updated successfully for server in ${serverDir}`);

    } catch (error) {
        console.error(`[setConfiguration] Error updating configuration: ${error.message}`);
    }
};

// Função para iniciar a preparação dos dados de cada evento
async function makeEventsData(Event) {

    console.log('[makeEventsData] Iniciado! Event: ', JSON.stringify(Event));

    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_iniciado", "3.1", "success", `[makeEventsData] Iniciado!`);

    Event.QueueMsgs = []; // Inicializar fila de mensagens para o evento
    Event.webSocket_clients = []; // Inicializar a lista de clientes conectados via WebSocket

    const { eventId, start_date, CfgEventFile, eventRules, settings } = Event;

    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_variables", "3.2", "success", `[makeEventsData] Calling: const { eventId, start_date, CfgEventFile, eventRules, settings } = Event`);

    // console.log(`\n----> Event Data: ${JSON.stringify({ eventId, start_date, CfgEventFile, eventRules, settings }, null, 2)}`);

    // 1. Copiar a pasta do servidor base
    const serverDir = await copyServerBase(eventId);
    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_copy_server_base", "3.3", "success", `[makeEventsData] chamado copyServerBase, serverDir: ${serverDir}`);

    // 2. Atualizar o arquivo event.json
    await updateEventJson(serverDir, CfgEventFile);
    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_update_event_json", "3.4", "success", `[makeEventsData] chamado updateEventJson`);

    // 3. Atualizar o arquivo eventRules.json
    await updateEventRules(serverDir, eventRules);
    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_update_event_rules", "3.5", "success", `[makeEventsData] chamado updateEventRules`);

    // 4. Atualizar o arquivo settings.json
    await updateSettings(serverDir, settings);
    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_update_settings", "3.6", "success", `[makeEventsData] chamado updateSettings`);

    // 5. Calcular o tempo de início
    const startTime = calculateStartTime(start_date);
    //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_calculate_start_time", "3.7", "success", `[makeEventsData] chamado calculateStartTime`);

    const safetyMargin = 1000;

    if (startTime > safetyMargin) {
        //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_check_start_time", "3.8", "success", `[makeEventsData] Servidor ${eventId} será iniciado em ${startTime / 1000} segundos`);
        console.log(`[makeEventsData] Servidor ${eventId} será iniciado em ${startTime / 1000} segundos`);
        setLongTimeout(async () => {
            
            // 5. Setar arquivo configuration com porta valida
            await setConfiguration(serverDir);

            startServer(serverDir, Event);
            sendMessagesToClient(Event);
            await registerDriversOnEntrylist(serverDir, Event);
        }, startTime, eventId);
    } else {
        console.log(`[makeEventsData] A hora de início do evento ${eventId} já passou. Iniciando o servidor imediatamente.`);
        startServer(serverDir, Event);
        sendMessagesToClient(Event);
        //await sendTrace("AccModuleServer-ReceiveEvent", "backend_make_events_check_start_time", "3.8", "success", `[makeEventsData] A hora de início do evento ${eventId} já passou. Iniciando o servidor imediatamente.`);
    }

}

// Iniciar o script
(async () => {
    await loadMessagesFilter();
    startHttp();
})();