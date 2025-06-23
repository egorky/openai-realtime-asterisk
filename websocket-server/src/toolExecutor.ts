import { LoggerInstance, CallSpecificConfig } from './types';
import { logConversationToRedis } from './redis-client';

// Datos de ejemplo simulados (similares a sampleData.ts del ejemplo)
const exampleAccountInfo = {
  account_id: "ACC12345",
  customer_name: "John Doe",
  plan_name: "Premium Unlimited",
  billing_cycle_end: "2024-07-30",
  data_usage_gb: 25.5,
  is_autopay_enabled: true,
};

const examplePolicyDocs = [
  {
    id: "ID-001",
    name: "Data Usage Policy",
    topic: "data usage",
    content: "Our plans offer generous data allowances. Exceeding your allowance may result in slower speeds or additional charges depending on your plan details.",
  },
  {
    id: "ID-010",
    name: "Family Plan Policy",
    topic: "family plan options",
    content: "The family plan allows up to 5 lines per account. All lines share a single data pool. Each additional line after the first receives a 10% discount. All lines must be on the same account.",
  },
  {
    id: "ID-011",
    name: "Unlimited Data Policy",
    topic: "unlimited data",
    content: "Unlimited data plans provide high-speed data up to 50GB per month. After 50GB, speeds may be reduced during network congestion. All lines on a family plan share the same data pool. Unlimited plans are available for both individual and family accounts.",
  }
];

const exampleStoreLocations = [
  {
    id: "STORE-A",
    name: "NewTelco Downtown",
    address: "123 Main St, Anytown, USA",
    zip_code: "90001",
    hours: "Mon-Sat: 9am-9pm, Sun: 10am-6pm",
  },
  {
    id: "STORE-B",
    name: "NewTelco Uptown",
    address: "456 Oak Ave, Anytown, USA",
    zip_code: "90002",
    hours: "Mon-Fri: 10am-8pm, Sat: 10am-7pm, Sun: Closed",
  },
];

// Interface para lo que esperamos de OpenAI cuando pide una llamada a herramienta
// Basado en la documentación de OpenAI y el ejemplo de Realtime API.
export interface OpenAIToolCall {
  call_id: string; // Identificador único para esta llamada a herramienta específica, generado por OpenAI.
  type: "function"; // Por ahora solo soportamos 'function'
  function: {
    name: string;
    arguments: string; // Un string JSON con los argumentos
  };
}

// Interface para el resultado que devolvemos a OpenAI
export interface ToolResultPayload {
  tool_call_id: string; // Debe coincidir con el call_id de la OpenAIToolCall original
  output: string;       // El resultado de la ejecución de la herramienta, como un string JSON.
}


async function lookupPolicyDocument(topic: string | undefined, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing lookupPolicyDocument for topic: ${topic}`);
  if (!topic) {
    return { error: "Topic is required for lookupPolicyDocument." };
  }
  const lowerTopic = topic.toLowerCase();
  const results = examplePolicyDocs.filter(doc =>
    doc.topic.toLowerCase().includes(lowerTopic) ||
    doc.name.toLowerCase().includes(lowerTopic) ||
    doc.content.toLowerCase().includes(lowerTopic)
  );
  if (results.length === 0) {
    return { message: `No policy documents found for topic: ${topic}` };
  }
  return results; // Devuelve un array de documentos encontrados
}

async function getUserAccountInfo(phoneNumber: string | undefined, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing getUserAccountInfo for phone: ${phoneNumber}`);
  if (!phoneNumber) {
    return { error: "Phone number is required for getUserAccountInfo." };
  }
  // Simulación: si el número contiene "555", devuelve info de ejemplo.
  if (phoneNumber.includes("555")) {
    return exampleAccountInfo;
  }
  return { message: `No account information found for phone number: ${phoneNumber}` };
}

async function findNearestStore(zipCode: string | undefined, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing findNearestStore for zip: ${zipCode}`);
  if (!zipCode) {
    return { error: "Zip code is required for findNearestStore." };
  }
  const results = exampleStoreLocations.filter(store => store.zip_code === zipCode);
  if (results.length === 0) {
    return { message: `No stores found for zip code: ${zipCode}` };
  }
  return results; // Devuelve un array de tiendas encontradas
}


export async function executeTool(
  toolCall: OpenAIToolCall, // Usando la interfaz más precisa
  ariCallId: string,        // ID de la llamada telefónica (ARI callId)
  callLogger: LoggerInstance,
  _config: CallSpecificConfig // Configuración de la llamada, por si alguna herramienta la necesita en el futuro
): Promise<ToolResultPayload> {
  const { name: toolName, arguments: toolArgsString } = toolCall.function;
  const openAIToolCallId = toolCall.call_id; // Este es el ID que OpenAI espera de vuelta

  callLogger.info(`[ToolExecutor] Attempting to execute tool: ${toolName} for ARI callId: ${ariCallId}, OpenAI tool_call_id: ${openAIToolCallId}`);
  callLogger.debug(`[ToolExecutor] Arguments: ${toolArgsString}`);

  await logConversationToRedis(ariCallId, {
    actor: 'tool_call',
    type: 'tool_log',
    content: `Executing tool: ${toolName} (OpenAI call_id: ${openAIToolCallId}) with args: ${toolArgsString}`,
    tool_name: toolName,
  });

  let resultData: any;
  let parsedArgs: any;

  try {
    parsedArgs = JSON.parse(toolArgsString);
  } catch (e: any) {
    callLogger.error(`[ToolExecutor] Failed to parse arguments for tool ${toolName}: ${e.message}`);
    resultData = { error: `Invalid arguments format for ${toolName}: ${e.message}` };

    await logConversationToRedis(ariCallId, {
      actor: 'tool_response',
      type: 'tool_log',
      content: `Error parsing args for ${toolName} (OpenAI call_id: ${openAIToolCallId}): ${resultData.error}`,
      tool_name: toolName,
    });

    return {
      tool_call_id: openAIToolCallId,
      output: JSON.stringify(resultData),
    };
  }

  try {
    switch (toolName) {
      case 'lookupPolicyDocument': // Asegúrate que los nombres coincidan con los schemas enviados a OpenAI
      case 'lookup_policy_document':
        resultData = await lookupPolicyDocument(parsedArgs.topic, callLogger);
        break;
      case 'getUserAccountInfo':
      case 'get_user_account_info':
        resultData = await getUserAccountInfo(parsedArgs.phone_number, callLogger);
        break;
      case 'findNearestStore':
      case 'find_nearest_store':
        resultData = await findNearestStore(parsedArgs.zip_code, callLogger);
        break;
      default:
        callLogger.warn(`[ToolExecutor] Unknown tool called: ${toolName}`);
        resultData = { error: `Tool '${toolName}' not found or not implemented.` };
    }
  } catch (executionError: any) {
    callLogger.error(`[ToolExecutor] Error during execution of tool ${toolName}: ${executionError.message}`, executionError);
    resultData = { error: `Execution error in ${toolName}: ${executionError.message}` };
  }

  const resultOutputString = JSON.stringify(resultData);
  callLogger.info(`[ToolExecutor] Result for tool ${toolName} (OpenAI tool_call_id: ${openAIToolCallId}): ${resultOutputString.substring(0, 200)}...`);

  await logConversationToRedis(ariCallId, {
    actor: 'tool_response',
    type: 'tool_log',
    content: `Result for ${toolName} (OpenAI call_id: ${openAIToolCallId}): ${resultOutputString}`,
    tool_name: toolName,
  });

  return {
    tool_call_id: openAIToolCallId, // Usar el call_id original de la tool_call de OpenAI
    output: resultOutputString,
  };
}
