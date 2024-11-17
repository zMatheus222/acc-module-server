const http = require('http');

function updateEndpoint(endpoint) {
    return new Promise((resolve, reject) => {

        const options = {
            hostname: 'localhost',
            port: 8083,
            path: `/update_${endpoint}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunck) => {
                data += chunck;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    console.log(`Endpoint ${endpoint} atualizado com sucesso`);
                    resolve(data);
                } else {
                    reject(new Error(`Falha na atualização do endpoint ${endpoint}. Status: ${res.statusCode}`));
                }
            });

            req.on('error', (error) => {
                console.error(`Erro ao atualizar ${endpoint}:`, error);
                reject(error);
            });

            req.end();

        });

    });
}

module.exports = { updateEndpoint };