import { LoggerInstance, CallSpecificConfig } from './types';
import { logConversationToRedis } from './redis-client';
import { getAvailableSlots, scheduleAppointment } from './functionHandlers';

// --- Mock Data ---
const exampleAccountInfo = {
  account_id: "ACC12345",
  customer_name: "Juan Pérez",
  plan_name: "Premium Ilimitado",
  billing_cycle_end: "2024-07-30",
  data_usage_gb: 25.5,
  is_autopay_enabled: true,
  address: {
    street: "Calle Falsa 123",
    city: "Ciudad Ejemplo",
    state: "Provincia Ejemplo",
    postal_code: "12345"
  }
};

const examplePolicyDocs = [
  {
    id: "ID-001",
    name: "Política de Uso de Datos",
    topic: "uso de datos",
    content: "Nuestros planes ofrecen generosas asignaciones de datos. Exceder tu asignación puede resultar en velocidades más lentas o cargos adicionales dependiendo de los detalles de tu plan.",
  },
  {
    id: "ID-010",
    name: "Política del Plan Familiar",
    topic: "opciones de plan familiar",
    content: "El plan familiar permite hasta 5 líneas por cuenta. Todas las líneas comparten un único grupo de datos. Cada línea adicional después de la primera recibe un descuento del 10%. Todas las líneas deben estar en la misma cuenta.",
  },
  {
    id: "ID-011",
    name: "Política de Datos Ilimitados",
    topic: "datos ilimitados",
    content: "Los planes de datos ilimitados proporcionan datos de alta velocidad hasta 50GB por mes. Después de 50GB, las velocidades pueden reducirse durante la congestión de la red. Todas las líneas en un plan familiar comparten el mismo grupo de datos. Los planes ilimitados están disponibles tanto para cuentas individuales como familiares.",
  }
];

const exampleStoreLocations = [
  {
    id: "TIENDA-A",
    name: "NewTelco Centro",
    address: "Calle Principal 123, Ciudad Ejemplo",
    zip_code: "90001",
    hours: "Lun-Sáb: 9am-9pm, Dom: 10am-6pm",
  },
  {
    id: "TIENDA-B",
    name: "NewTelco Norte",
    address: "Avenida Roble 456, Ciudad Ejemplo",
    zip_code: "90002",
    hours: "Lun-Vie: 10am-8pm, Sáb: 10am-7pm, Dom: Cerrado",
  },
];

const exampleOrders = [
    {
      order_id: 'SNP-20230914-001',
      order_date: '2024-09-14T09:30:00Z',
      delivered_date: '2024-09-16T14:00:00Z',
      order_status: 'entregado',
      subtotal_usd: 409.98,
      total_usd: 471.48,
      items: [
        { item_id: 'SNB-TT-X01', item_name: 'Tabla de Snowboard Twin Tip X', retail_price_usd: 249.99, },
        { item_id: 'SNB-BOOT-ALM02', item_name: 'Botas de Snowboard All-Mountain', retail_price_usd: 159.99,},
      ],
    },
];

const exampleSales = [
      { item_id: 101, type: 'snowboard', name: 'Cuchilla Alpina', retail_price_usd: 450, sale_price_usd: 360, sale_discount_pct: 20 },
      { item_id: 102, type: 'snowboard', name: 'Bombardero de Cima', retail_price_usd: 499, sale_price_usd: 374, sale_discount_pct: 25 },
      { item_id: 201, type: 'apparel', name: 'Chaqueta Térmica', retail_price_usd: 120, sale_price_usd: 84, sale_discount_pct: 30 },
];


// --- Interfaces ---
export interface OpenAIToolCall {
  call_id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResultPayload {
  tool_call_id: string;
  output: string;
}

// --- Tool Implementations (Mocks) ---

async function authenticate_user_information(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing authenticate_user_information with args: ${JSON.stringify(args)}`);
  // Mock: Simulate successful authentication if phone_number is present
  if (args.phone_number) {
    return { success: true, message: "Usuario autenticado exitosamente." };
  }
  return { success: false, error: "Faltan detalles para la autenticación." };
}

async function save_or_update_address(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing save_or_update_address with args: ${JSON.stringify(args)}`);
  if (args.phone_number && args.new_address && args.new_address.street) {
    return { success: true, message: `Dirección actualizada para ${args.phone_number}.` };
  }
  return { success: false, error: "Faltan detalles para guardar la dirección." };
}

async function update_user_offer_response(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing update_user_offer_response with args: ${JSON.stringify(args)}`);
  if (args.phone && args.offer_id && args.user_response) {
    return { success: true, message: `Respuesta a la oferta ${args.offer_id} registrada como ${args.user_response}.` };
  }
  return { success: false, error: "Faltan detalles para actualizar la respuesta a la oferta." };
}

async function lookupOrders(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing lookupOrders with args: ${JSON.stringify(args)}`);
  if (args.phoneNumber) {
    // Simulate finding orders for any phone number for now
    return { orders: exampleOrders };
  }
  return { orders: [], message: "No se encontraron pedidos para ese número de teléfono." };
}

async function retrievePolicy(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing retrievePolicy with args: ${JSON.stringify(args)}`);
  // Simplified: return a generic policy or a specific one if category matches
  const policy = examplePolicyDocs.find(p => args.itemCategory && p.topic.includes(args.itemCategory.toLowerCase()));
  if (policy) {
    return { policy: policy.content };
  }
  return { policy: "Nuestra política de devoluciones general es de 30 días para artículos sin usar con etiquetas."};
}

async function checkEligibilityAndPossiblyInitiateReturn(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing checkEligibilityAndPossiblyInitiateReturn with args: ${JSON.stringify(args)}`);
  // Mock logic: always eligible for now
  return {
    isEligible: true,
    rationale: "El artículo cumple con los criterios de elegibilidad simulados.",
    returnNextSteps: "Recibirá un correo electrónico con una etiqueta de envío e instrucciones.",
    additionalInformationNeeded: "Ninguna"
  };
}

async function lookupNewSales(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing lookupNewSales with args: ${JSON.stringify(args)}`);
  const category = args.category?.toLowerCase();
  let sales = exampleSales;
  if (category && category !== 'any') {
    sales = exampleSales.filter(s => s.type === category);
  }
  return { sales: sales.length > 0 ? sales : [{ message: "No hay ofertas especiales en esta categoría en este momento." }] };
}

async function addToCart(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing addToCart with args: ${JSON.stringify(args)}`);
  if (args.item_id) {
    return { success: true, message: `Artículo ${args.item_id} añadido al carrito.` };
  }
  return { success: false, error: "Falta el ID del artículo." };
}

async function checkout(args: any, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Executing checkout with args: ${JSON.stringify(args)}`);
  if (args.item_ids && args.item_ids.length > 0 && args.phone_number) {
    return { success: true, checkoutUrl: `https://example.com/checkout?items=${args.item_ids.join(',')}&user=${args.phone_number}` };
  }
  return { success: false, error: "Faltan artículos o número de teléfono para el checkout." };
}


// --- Existing Tool Implementations ---
async function lookupPolicyDocument(topic: string | undefined, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Ejecutando lookupPolicyDocument para tema: ${topic}`);
  if (!topic) {
    return { error: "Se requiere un tema para lookupPolicyDocument." };
  }
  const lowerTopic = topic.toLowerCase();
  const results = examplePolicyDocs.filter(doc =>
    doc.topic.toLowerCase().includes(lowerTopic) ||
    doc.name.toLowerCase().includes(lowerTopic) ||
    doc.content.toLowerCase().includes(lowerTopic)
  );
  if (results.length === 0) {
    return { message: `No se encontraron documentos de política para el tema: ${topic}` };
  }
  return results;
}

async function getUserAccountInfo(phoneNumber: string | undefined, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Ejecutando getUserAccountInfo para teléfono: ${phoneNumber}`);
  if (!phoneNumber) {
    return { error: "Se requiere número de teléfono para getUserAccountInfo." };
  }
  if (phoneNumber.includes("555")) { // Mock
    return exampleAccountInfo;
  }
  return { message: `No se encontró información de cuenta para el número de teléfono: ${phoneNumber}` };
}

async function findNearestStore(zipCode: string | undefined, callLogger: LoggerInstance): Promise<any> {
  callLogger.info(`[ToolExecutor] Ejecutando findNearestStore para código postal: ${zipCode}`);
  if (!zipCode) {
    return { error: "Se requiere código postal para findNearestStore." };
  }
  const results = exampleStoreLocations.filter(store => store.zip_code === zipCode);
  if (results.length === 0) {
    return { message: `No se encontraron tiendas para el código postal: ${zipCode}` };
  }
  return results;
}

import { saveSessionParams, disconnectRedis } from './redis-client';
import { ariClientServiceInstance } from './ari-service';

// --- Main executeTool Function ---
export async function executeTool(
  toolCall: OpenAIToolCall,
  ariCallId: string,
  callLogger: LoggerInstance,
  _config: CallSpecificConfig
): Promise<ToolResultPayload> {
  const { name: toolName, arguments: toolArgsString } = toolCall.function;
  const openAIToolCallId = toolCall.call_id;

  callLogger.info(`[ToolExecutor] Intentando ejecutar herramienta: ${toolName} para ARI callId: ${ariCallId}, OpenAI tool_call_id: ${openAIToolCallId}`);
  callLogger.debug(`[ToolExecutor] Argumentos: ${toolArgsString}`);

  await logConversationToRedis(ariCallId, {
    actor: 'tool_call',
    type: 'tool_log',
    content: `Ejecutando herramienta: ${toolName} (OpenAI call_id: ${openAIToolCallId}) con args: ${toolArgsString}`,
    tool_name: toolName,
  });

  let resultData: any;
  let parsedArgs: any;

  try {
    parsedArgs = JSON.parse(toolArgsString);
    await saveSessionParams(ariCallId, parsedArgs);
  } catch (e: any) {
    callLogger.error(`[ToolExecutor] Fallo al parsear argumentos para herramienta ${toolName}: ${e.message}`);
    resultData = { error: `Formato de argumentos inválido para ${toolName}: ${e.message}` };

    await logConversationToRedis(ariCallId, {
      actor: 'tool_response',
      type: 'tool_log',
      content: `Error parseando args para ${toolName} (OpenAI call_id: ${openAIToolCallId}): ${resultData.error}`,
      tool_name: toolName,
    });

    return {
      tool_call_id: openAIToolCallId,
      output: JSON.stringify(resultData),
    };
  }

  try {
    switch (toolName) {
      // Existing tools
      case 'lookupPolicyDocument':
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

      // Added tools from authenticationAgent
      case 'authenticate_user_information':
        resultData = await authenticate_user_information(parsedArgs, callLogger);
        break;
      case 'save_or_update_address':
        resultData = await save_or_update_address(parsedArgs, callLogger);
        break;
      case 'update_user_offer_response':
        resultData = await update_user_offer_response(parsedArgs, callLogger);
        break;

      // Added tools from returnsAgent
      case 'lookupOrders':
        resultData = await lookupOrders(parsedArgs, callLogger);
        break;
      case 'retrievePolicy':
        resultData = await retrievePolicy(parsedArgs, callLogger);
        break;
      case 'checkEligibilityAndPossiblyInitiateReturn':
        resultData = await checkEligibilityAndPossiblyInitiateReturn(parsedArgs, callLogger);
        break;

      // Added tools from salesAgent
      case 'lookupNewSales':
        resultData = await lookupNewSales(parsedArgs, callLogger);
        break;
      case 'addToCart':
        resultData = await addToCart(parsedArgs, callLogger);
        break;
      case 'checkout':
        resultData = await checkout(parsedArgs, callLogger);
        break;

      case 'get_available_slots':
        resultData = await getAvailableSlots(parsedArgs);
        break;
      case 'scheduleAppointment':
        resultData = await scheduleAppointment(parsedArgs);
        break;

      case 'save_parameters':
        // This tool just saves the parameters to Redis, which is already handled by the `saveSessionParams` call below.
        resultData = { success: true, message: "Parameters saved." };
        break;

      case 'endCall':
        callLogger.info(`[ToolExecutor] Executing endCall for ARI callId: ${ariCallId}`);
        if (ariClientServiceInstance) {
          await ariClientServiceInstance.endCall(ariCallId);
          resultData = { success: true, message: "Call termination initiated." };
        } else {
          callLogger.error(`[ToolExecutor] ariClientServiceInstance is not available to end the call.`);
          resultData = { success: false, error: "Call service not available." };
        }
        break;

      default:
        callLogger.warn(`[ToolExecutor] Herramienta desconocida llamada: ${toolName}`);
        resultData = { error: `Herramienta '${toolName}' no encontrada o no implementada.` };
    }
  } catch (executionError: any) {
    callLogger.error(`[ToolExecutor] Error durante la ejecución de la herramienta ${toolName}: ${executionError.message}`, executionError);
    resultData = { error: `Error de ejecución en ${toolName}: ${executionError.message}` };
  }

  const resultOutputString = JSON.stringify(resultData);
  callLogger.info(`[ToolExecutor] Resultado para herramienta ${toolName} (OpenAI tool_call_id: ${openAIToolCallId}): ${resultOutputString.substring(0, 200)}...`);

  await logConversationToRedis(ariCallId, {
    actor: 'tool_response',
    type: 'tool_log',
    content: `Resultado para ${toolName} (OpenAI call_id: ${openAIToolCallId}): ${resultOutputString}`,
    tool_name: toolName,
  });

  return {
    tool_call_id: openAIToolCallId,
    output: resultOutputString,
  };
}
