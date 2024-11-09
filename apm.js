const apm = require('elastic-apm-node').start({
    serviceName: 'acc-module-server',
    //secretToken: 'seu-secret-token', // opcional, use se o APM server estiver protegido
    serverUrl: 'http://localhost:8200', // URL do seu servidor APM
    environment: 'development', // ou 'production', dependendo do ambiente
});

if(!apm.isStarted()) console.log('elastic-apm-node não foi inicializado corretamente.');

module.exports = apm;