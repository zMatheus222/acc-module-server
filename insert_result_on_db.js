const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const iconv = require('iconv-lite'); // Importa a biblioteca iconv-lite

// Função para inserir dados no banco de dados
async function insertIntoDatabase(sessionData, Event, sessionType) {
    
    console.log(`[insertIntoDatabase] Iniciado!\nsessionData:\n${JSON.stringify(sessionData)}\nEvent:\n${JSON.stringify(Event)}`);
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
        await client.connect();

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

        /*
        acc.sessoes:
        "id"	"etapa_id"	"sessiontype"	"dayofweekend"	"hourofday"	"sessiondurationminutes"	"timemultiplier"
          1	         1	          "P"	           1	        10             	60	                       1
        */

        // Inserir dados na tabela acc.sessoes e retornar id da sessão inserida
        const resultSessao = await client.query(
            `INSERT INTO acc.sessoes (etapa_id, sessiontype, dayofweekend, hourofday, sessiondurationminutes, timemultiplier)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, 
            [parseInt(Event.etapa, 10), sessionType, parseInt(Session.dayOfWeekend, 10), parseInt(Session.hourOfDay, 10), parseInt(Session.sessionDurationMinutes, 10), parseFloat(Session.timeMultiplier)]
        );
        
        const id_sessao = resultSessao.rows[0].id;

        console.log('[insertIntoDatabase] Dados da sessão inseridos com sucesso.');

        // Verifique se leaderBoardLines existe e é um array
        if (!Array.isArray(sessionData.sessionResult.leaderBoardLines)) {
            console.error('[insertIntoDatabase] leaderBoardLines não é um array valido ou está indefinido:', JSON.stringify(sessionData));
            return;
        }

        for (const result of sessionData.sessionResult.leaderBoardLines) {

            console.log('----> piloto: ', result);

            /*
            acc.resultline:
            "id_sessao"	 "id_piloto"	"id_classe"	"carmodel"	"lapcount"	"bestlap"	"totaltime"
                1	          1	           1	        30        	28	      50237	       122676
            */

            // iterar sobre todos os pilotos de base.pilotos com base no steam guid de car.drivers[0].playerId
            // somente inserir o dado de resultado se for o piloto correto
            for (piloto of base_pilotos.rows) {
                if (piloto.id && piloto.steam_guid === result.car.drivers[0].playerId) {
                    await client.query(
                        `INSERT INTO acc.resultline (id_sessao, id_piloto, id_classe, carmodel, lapcount, bestlap, totaltime) 
                        VALUES ($1, $2, $3, $4, $5, $6, $7)`, 
                        [id_sessao, piloto.id, result.car.cupCategory + 1, result.car.carModel, result.timing.lapCount, result.timing.bestLap, result.timing.totalTime]
                    );       
                }
            }

        }

        console.log('[insertIntoDatabase] Dados do leaderboard inseridos com sucesso!');

        // if(sessionType === 'R') {
        //     console.log(`[${Event.eventId}] Evento finalizado!`);
        //     await client.end();
        //     process.exit(0);
        // }

    } catch (err) {
        console.error('Erro ao inserir dados:', err);
    } finally {
        await client.end();
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

    console.log('[insertResult] Iniciado! Event: ', Event);

    // Verifique se eventId existe e não está undefined
    if (!Event.eventId) {
        console.error('[insertResult] eventId não definido em Event:', JSON.stringify(Event));
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

// Função para atualizar o endpoint do redis
async function UpdateRedisEndpoint(){
    const options = { hostname: '185.101.104.129', port: 8083, path: '/update_get_eventos', method: 'POST', headers: { 'Content-Type': 'application/json', }};

    const req = http.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunck) => { responseData += chunck });
        res.on('end', () => { console.log('[UpdateRedisEndpoint] Response:', responseData) });
    });

    req.on('error', (e) => { console.error(`[UpdateRedisEndpoint] Erro: ${e.message}`); });
};

// Obter o caminho do arquivo e o tipo de sessão dos argumentos
const [tempFilePath, sessionType] = process.argv.slice(2);

if (tempFilePath && sessionType) {
    console.log('[insert_result_on_db.js] Passed if (tempFilePath && sessionType)');

    try {
        // Ler o conteúdo do arquivo temporário
        const EventString = fs.readFileSync(tempFilePath, 'utf8');
        
        // Desserializa a string JSON para um objeto
        const Event = JSON.parse(EventString);
        
        insertResult(Event, sessionType);

        UpdateRedisEndpoint();
    } catch (err) {
        console.error('[insert_result_on_db.js] Erro ao ler ou processar o arquivo:', err.message);
    }
} else {
    console.log('Uso: node insert_result_on_db.js <caminho_do_arquivo_temporario> <sessionType>');
}