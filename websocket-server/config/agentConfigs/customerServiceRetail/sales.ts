import { RealtimeAgent, tool } from '@openai/agents/realtime';

export const salesAgent = new RealtimeAgent({
  name: 'salesAgent', // Nombre técnico, mantener en inglés
  voice: 'sage', // Nombre técnico de la voz
  handoffDescription:
    "Maneja consultas relacionadas con ventas, incluyendo detalles de nuevos productos, recomendaciones, promociones y flujos de compra. Debe ser redirigido si el usuario está interesado en comprar o explorar nuevas ofertas.", // Traducido

  instructions:
    "Eres un útil asistente de ventas. Proporciona información completa sobre promociones disponibles, ofertas actuales y recomendaciones de productos. Ayuda al usuario con cualquier consulta de compra y guíalo a través del proceso de pago cuando esté listo. Cuando la conversación haya terminado y el usuario confirme que no necesita nada más, DEBES usar la herramienta endCall para finalizar la llamada.",


  tools: [
    tool({
        name: 'endCall',
        description: 'Finaliza la llamada telefónica. Úsalo cuando la conversación haya terminado.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
        },
        execute: async () => ({ success: true }),
    }),
    tool({
      name: 'lookupNewSales',
      description:
        "Verifica promociones actuales, descuentos u ofertas especiales. Responde con ofertas disponibles relevantes para la consulta del usuario.", // Traducido
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['snowboard', 'apparel', 'boots', 'accessories', 'any'], // Mantener valores técnicos en inglés
            description: 'La categoría de producto o área general en la que el usuario está interesado (opcional).', // Traducido
          },
        },
        required: ['category'],
        additionalProperties: false,
      },
      execute: async (input: any) => {
        const { category } = input as { category: string };
        const items = [ // Los nombres de los items pueden ser traducidos si son para mostrar al usuario, o mantenidos si son identificadores. Asumiré que pueden ser traducidos.
          { item_id: 101, type: 'snowboard', name: 'Cuchilla Alpina', retail_price_usd: 450, sale_price_usd: 360, sale_discount_pct: 20 },
          { item_id: 102, type: 'snowboard', name: 'Bombardero de Cima', retail_price_usd: 499, sale_price_usd: 374, sale_discount_pct: 25 },
          { item_id: 201, type: 'apparel', name: 'Chaqueta Térmica', retail_price_usd: 120, sale_price_usd: 84, sale_discount_pct: 30 },
          { item_id: 202, type: 'apparel', name: 'Pantalones Aislantes', retail_price_usd: 150, sale_price_usd: 112, sale_discount_pct: 25 },
          { item_id: 301, type: 'boots', name: 'Agarre Glaciar', retail_price_usd: 250, sale_price_usd: 200, sale_discount_pct: 20 },
          { item_id: 302, type: 'boots', name: 'Pasos de Cumbre', retail_price_usd: 300, sale_price_usd: 210, sale_discount_pct: 30 },
          { item_id: 401, type: 'accessories', name: 'Gafas Protectoras', retail_price_usd: 80, sale_price_usd: 60, sale_discount_pct: 25 },
          { item_id: 402, type: 'accessories', name: 'Guantes Cálidos', retail_price_usd: 60, sale_price_usd: 48, sale_discount_pct: 20 },
        ];
        const filteredItems =
          category === 'any'
            ? items
            : items.filter((item) => item.type === category);
        filteredItems.sort((a, b) => b.sale_discount_pct - a.sale_discount_pct);
        return {
          sales: filteredItems,
        };
      },
    }),

    tool({
      name: 'addToCart',
      description: "Añade un artículo al carrito de compras del usuario.", // Traducido
      parameters: {
        type: 'object',
        properties: {
          item_id: {
            type: 'string',
            description: 'El ID del artículo para añadir al carrito.', // Traducido
          },
        },
        required: ['item_id'],
        additionalProperties: false,
      },
      execute: async (input: any) => ({ success: true }),
    }),

    tool({
      name: 'checkout',
      description:
        "Inicia un proceso de pago con los artículos seleccionados por el usuario.", // Traducido
      parameters: {
        type: 'object',
        properties: {
          item_ids: {
            type: 'array',
            description: 'Un array de IDs de artículos que el usuario pretende comprar.', // Traducido
            items: {
              type: 'string',
            },
          },
          phone_number: {
            type: 'string',
            description: "Número de teléfono del usuario utilizado para verificación. Formateado como '(111) 222-3333'", // Traducido
            pattern: '^\\(\\d{3}\\) \\d{3}-\\d{4}$',
          },
        },
        required: ['item_ids', 'phone_number'],
        additionalProperties: false,
      },
      execute: async (input: any) => ({ checkoutUrl: 'https://example.com/checkout' }),
    }),
  ],

  handoffs: [],
});
