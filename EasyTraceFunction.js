const axios = require('axios');

const sendTrace = async (flow_name, step_name, step_number, status, description) => {
    try {

        let td = {
            flow_name: flow_name,
            step_name: step_name,
            step_number: step_number,
            status: status,
            description: description
        };

        // Validação básica dos campos obrigatórios
        if (!td.flow_name || !td.step_name || !td.step_number || !td.status || !td.description) {
            throw new Error("[sendTrace] Missing required fields in trace data.");
        }

        const toSendTraceData = {
            flow_name: td.flow_name,
            step_name: td.step_name,
            step_number: td.step_number,
            status: td.status,
            description: td.description
        }

        console.log(`[sendTrace] Enviando trace: `, toSendTraceData);
        
        const response = await axios.post('http://185.101.104.252:43500/api/receive_trace', toSendTraceData);
        console.log('[sendTrace] Metric sent successfully', response.data);
    } catch (error) {
        console.error('[sendTrace] Error sending metric:', error);
    }
};

module.exports = { sendTrace };