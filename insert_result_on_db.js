//const apm = require('./apm');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const iconv = require('iconv-lite'); // Importa a biblioteca iconv-lite
const { updateEndpointsWithDelay } = require('./updateEndpoint');
const axios = require('axios');

// Função para inserir dados no banco de dados
async function insertIntoDatabase(sessionData, Event, sessionType) {

    console.log(`[insertIntoDatabase] Iniciado com sessionType: ${sessionType}, etapa_primary_id: ${etapa_primary_id}`);
    
    if (sessionData.sessionResult.leaderBoardLines.length === 0) {
        console.log('Arquivo de resultado com leaderBoardLines vazia, ignorando...');
        return;
    }

    const config = JSON.parse(fs.readFileSync('./config.json'));

    const client = new Client({
        user: config.cfgs.postgresql.user,
        host: config.cfgs.postgresql.hostaddr,
        database: config.cfgs.postgresql.dbname,
        password: config.cfgs.postgresql.password,
        port: config.cfgs.postgresql.port,
    });

    try {
        console.log('[insertIntoDatabase] Tentando conectar ao banco de dados...');
        await client.connect();
        console.log('[insertIntoDatabase] Conexão com o banco de dados estabelecida.');

        if (!Event.CfgEventFile || !Array.isArray(Event.CfgEventFile.sessions)) {
            console.error('[insertIntoDatabase] CfgEventFile ou sessions indefinido:', JSON.stringify(Event));
            return;
        }

        // coletar dados referente ao Event (sessao === ao tipo passado, P Q ou R)
        const Session = Event.CfgEventFile.sessions.find(session => session.sessionType === sessionType);

        // Realizar querys antes do for e iterar depois:

        // coletar todos os ids de pilotos da tabela base.pilotos
        const base_pilotos = await client.query('SELECT id, steam_guid FROM base.pilotos');
        if (base_pilotos.rows.length === 0) {
            console.error('[insertIntoDatabase] Nenhum piloto encontrado na tabela base.pilotos');
        }

        console.log(`[insertIntoDatabase] Executando query para buscar sessão. etapa_primary_id: ${etapa_primary_id}, sessionType: ${sessionType}`);
        const resultSessao = await client.query(`SELECT id FROM acc.sessoes WHERE etapa_id = $1 AND sessiontype = $2`, [etapa_primary_id, sessionType]);
        console.log(`[insertIntoDatabase] Query executada. Resultado:`, resultSessao.rows);

        if (resultSessao.rows.length === 0) {
            console.error(`[insertIntoDatabase] Nenhuma sessão encontrada para etapa_id ${etapa_primary_id} e sessiontype ${sessionType}`);
            return;
        }
        
        const id_sessao = resultSessao.rows[0].id;
        console.log(`[insertIntoDatabase] id da sessão encontrado: ${id_sessao}`);

        // Verifique se leaderBoardLines existe e é um array
        if (!Array.isArray(sessionData.sessionResult.leaderBoardLines)) {
            console.error('[insertIntoDatabase] leaderBoardLines não é um array valido ou está indefinido:', JSON.stringify(sessionData));
            return;
        }

        for (const result of sessionData.sessionResult.leaderBoardLines) {

            console.log('----> piloto: ', result);

            let piloto_encontrado = false;
            
            // iterar sobre todos os pilotos de base.pilotos com base no steam guid de car.drivers[0].playerId
            // somente inserir o dado de resultado se for o piloto correto
            for (piloto of base_pilotos.rows) {

                // Verificar os pilotos 'result.car.drivers[0].playerId' que sobraram (não foram encontrados no 'base_pilotos.rows')
                // e fazer um console.warn para avisar que o piloto está no arquivo de resultado mas não foi encontrado no base_pilotos.rows

                // verificar
                if (piloto.id && piloto.steam_guid === result.car.drivers[0].playerId) {
                    piloto_encontrado = true;
                    await client.query(
                        `INSERT INTO acc.resultline (id_sessao, id_piloto, id_classe, carmodel, lapcount, bestlap, totaltime) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`, 
                        [id_sessao, piloto.id, result.car.cupCategory + 1, result.car.carModel, result.timing.lapCount, result.timing.bestLap, result.timing.totalTime]
                    );
                    break;
                }
            }

            if (!piloto_encontrado) {
                console.warn(`Aviso: Piloto com steam_guid: ${result.car.drivers[0].playerId} está no arquivo de resultado mas não foi encontrado na base de pilotos.`);
            }

        }

        console.log('[insertIntoDatabase] Dados do leaderboard inseridos com sucesso! Atualizando endpoints');

        // Mudar o status do evento (Event.eventId) para 'Finalizados'
        await client.query(`UPDATE acc.etapas SET status = 'Finalizados' WHERE eventid = $1`, [Event.eventId]);
        console.log(`[insertIntoDatabase] Alterado o status do eventId ${Event.eventId} para 'Finalizados' com sucesso!`);

        const endpointsToUpdate = [
            'view_temporadas_resultados_practices',
            'view_temporadas_resultados_qualys',
            'view_temporadas_resultados',
            'view_temporadas_resultados_all',
        ];

        await updateEndpointsWithDelay(endpointsToUpdate);
        console.log('[insertIntoDatabase] Todos os endpoints foram atualizados com sucesso.');

    } catch (err) {
        console.error('[insertIntoDatabase] Erro:', err);
        console.error('[insertIntoDatabase] Stack:', err.stack);
    } finally {
        console.log('[insertIntoDatabase] Fechando conexão com o banco de dados...');
        await client.end();
        console.log('[insertIntoDatabase] Conexão com o banco de dados fechada.');
    }
}

// Função para encontrar o arquivo correto de resultados baseado no sufixo da sessão
function findResultFile(directory, sessionType) {

    console.log('[findResultFile] Iniciado! directory: ', directory);

    const files = fs.readdirSync(directory);
    
    // Procurar por arquivos que terminam com _FP.json, _Q.json ou _R.json
    const sessionFileSuffix = {
        'P': '_FP.json',
        'Q': '_Q.json',
        'R': '_R.json'
    }[sessionType];

    console.log('[findResultFile] sessionFileSuffix: ', sessionFileSuffix);

    if (!sessionFileSuffix) {
        console.error('[findResultFile] Tipo de sessão inválido:', sessionType);
        return null;
    }

    // Filtrar o arquivo correto pelo sufixo
    const resultFile = files.find(file => file.endsWith(sessionFileSuffix));
    console.log(`[findResultFile] Suffix procurado: ${sessionFileSuffix}. Arquivos encontrados: ${files.join(', ')}`);

    console.log('[findResultFile] path.join(directory, resultFile): ', path.join(directory, resultFile));

    return resultFile ? path.join(directory, resultFile) : null;
}

// Função principal para ler o arquivo de resultado e inserir no banco
async function insertResult(Event, sessionType) {

    console.log('[insertResult] Iniciado! Event: ', Event, " sessionType: ", sessionType);

    // Verifique se eventId existe e não está undefined
    if (!Event.eventId) {
        console.error(`[insertResult] ${Event.eventId} não definido em Event:`, JSON.stringify(Event));
        return;
    }

    const resultFolderPath = path.join(__dirname, `${Event.eventId}-server/results`);
    console.log(`[insertResult] Caminho da pasta de resultados: ${resultFolderPath}`);

    // Encontrar o arquivo correto
    const resultFilePath = findResultFile(resultFolderPath, sessionType);
    if (!resultFilePath) {
        console.error('[insert_result_on_db] Arquivo de resultado não encontrado para o tipo de sessão:', sessionType);
        return;
    }
    console.log(`[insertResult] Arquivo de resultado encontrado: ${resultFilePath}`);

    // Ler o arquivo de resultado
    try {
        // Lê o arquivo e converte de UTF-16-LE para UTF-8
        console.log('[insertResult] Lendo o arquivo de resultado...');
        const rawData = fs.readFileSync(resultFilePath);
        console.log('[insertResult] Arquivo lido com sucesso, decodificando...');
        
        const utf16Data = iconv.decode(rawData, 'UTF-16LE'); // Decodifica o arquivo para UTF-8
        const sessionData = JSON.parse(utf16Data); // Faz o parse do JSON
        console.log('[insertResult] Arquivo decodificado e parseado com sucesso.');

        // Inserir os dados no banco de dados
        await insertIntoDatabase(sessionData, Event, sessionType);

    } catch (err) {
        console.error('[insert_result_on_db] Erro ao ler o arquivo de resultado:', err);
    }
}

console.log('Argumentos recebidos:', process.argv);

const [,, tempFilePath, sessionType, etapa_primary_id] = process.argv;

console.log('tempFilePath:', tempFilePath);
console.log('sessionType:', sessionType);
console.log('etapa_primary_id:', etapa_primary_id);

if (!tempFilePath || !sessionType || !etapa_primary_id) {
    console.error('Argumentos insuficientes. Uso: node insert_result_on_db.js <tempFilePath> <sessionType> <etapa_primary_id>');
    process.exit(1);
}

console.log(`[insert_result_on_db.js] tempFilePath: ${tempFilePath} || sessionType: ${sessionType} || etapa_primary_id: ${etapa_primary_id}`);

(async () => {
    try {
        const EventString = fs.readFileSync(tempFilePath, 'utf8');
        console.log(`File contents: ${EventString.substring(0, 100)}...`);
        
        const Event = JSON.parse(EventString);
        console.log(`Parsed Event: ${JSON.stringify(Event, null, 2)}`);
        
        await insertResult(Event, sessionType, etapa_primary_id);
        
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
        
        console.log('[insert_result_on_db] Todos os endpoints foram atualizados com sucesso.');
    } catch (error) {
        console.error('Erro ao executar insertResult ou atualizar endpoints:', error);
    }
})();