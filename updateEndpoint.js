const http = require('http');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateEndpoint(endpoint, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
        console.log(`[updateEndpoint] Tentando realizar o update do endpoint: ${endpoint} (Tentativa ${attempt + 1}/${retries})`);

        try {
            const result = await new Promise((resolve, reject) => {
                const options = {
                    hostname: '185.101.104.129',
                    port: 8083,
                    path: `/update_${endpoint}`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000 // 10 seconds timeout
                };

                const req = http.request(options, (res) => {
                    let data = '';

                    res.on('data', (chunk) => {
                        data += chunk;
                    });

                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            resolve(data);
                        } else {
                            reject(new Error(`HTTP status ${res.statusCode}`));
                        }
                    });
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });  

                req.on('error', (error) => {
                    reject(error);
                });

                req.end();
            });

            console.log(`[updateEndpoint] Endpoint ${endpoint} atualizado com sucesso`);
            return result;
        } catch (error) {
            console.error(`[updateEndpoint] Erro ao atualizar ${endpoint} (Tentativa ${attempt + 1}/${retries}):`, error.message);
            
            if (attempt === retries - 1) {
                throw error; // Throw on last attempt
            }

            // Wait before next attempt (exponential backoff)
            await delay(Math.pow(2, attempt) * 1000);
        }
    }
}

async function updateEndpointsWithDelay(endpoints, delayMs = 250) {
    for (const endpoint of endpoints) {
        try {
            await updateEndpoint(endpoint);
            await delay(delayMs);
        } catch (error) {
            console.error(`Failed to update ${endpoint} after all retries:`, error.message);
        }
    }
}

module.exports = { updateEndpointsWithDelay };