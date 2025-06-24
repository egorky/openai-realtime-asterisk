export const exampleAccountInfo = {
  accountId: "NT-123456", // ID de cuenta
  name: "Alex García", // Nombre
  phone: "+1-206-135-1246", // Teléfono
  email: "alex.garcia@email.com", // Correo electrónico
  plan: "Ilimitado Plus", // Plan
  balanceDue: "$42.17", // Saldo pendiente
  lastBillDate: "2024-05-15", // Fecha de última factura
  lastPaymentDate: "2024-05-20", // Fecha de último pago
  lastPaymentAmount: "$42.17", // Monto del último pago
  status: "Activo", // Estado
  address: { // Dirección
    street: "Calle Pino 1234", // Calle
    city: "Seattle", // Ciudad
    state: "WA", // Estado/Provincia
    zip: "98101" // Código Postal
  },
  lastBillDetails: { // Detalles de la última factura
    basePlan: "$30.00", // Plan base
    internationalCalls: "$8.00", // Llamadas internacionales
    dataOverage: "$4.00", // Exceso de datos
    taxesAndFees: "$0.17", // Impuestos y tarifas
    notes: "Más alta de lo habitual debido a llamadas internacionales y exceso de datos." // Notas
  }
};

export const examplePolicyDocs = [
  {
    id: "ID-010",
    name: "Política del Plan Familiar",
    topic: "opciones de plan familiar",
    content:
      "El plan familiar permite hasta 5 líneas por cuenta. Todas las líneas comparten un único grupo de datos. Cada línea adicional después de la primera recibe un descuento del 10%. Todas las líneas deben estar en la misma cuenta.",
  },
  {
    id: "ID-020",
    name: "Política de Promociones y Descuentos",
    topic: "promociones y descuentos",
    content:
      "La Venta de Verano de Datos Ilimitados ofrece un descuento del 20% en el plan Ilimitado Plus durante los primeros 6 meses para nuevas activaciones completadas antes del 31 de julio de 2024. El Bono por Recomendar a un Amigo ofrece un crédito de $50 en la factura tanto al cliente que refiere como al nuevo cliente después de 60 días de servicio activo, para activaciones antes del 31 de agosto de 2024. Se puede ganar un máximo de 5 créditos por recomendación por cuenta. Los descuentos no se pueden combinar con otras ofertas.",
  },
  {
    id: "ID-030",
    name: "Política de Planes Internacionales",
    topic: "planes internacionales",
    content:
      "Hay planes internacionales disponibles que incluyen llamadas, mensajes de texto y uso de datos con descuento en más de 100 países.",
  },
  {
    id: "ID-040",
    name: "Política de Ofertas de Teléfonos",
    topic: "teléfonos nuevos",
    content:
      "Hay disponibles teléfonos de marcas como iPhone y Google. El iPhone 16 cuesta $200 y el Google Pixel 8 está disponible por $0, ambos con un compromiso adicional de 18 meses. Estas ofertas son válidas hasta agotar existencias y pueden requerir planes o canjes elegibles. Para más detalles, visita una de nuestras tiendas.",
  },
];

export const exampleStoreLocations = [
  // NorCal
  {
    name: "Tienda NewTelco Centro de San Francisco",
    address: "1 Market St, San Francisco, CA",
    zip_code: "94105",
    phone: "(415) 555-1001",
    hours: "Lun-Sáb 10am-7pm, Dom 11am-5pm"
  },
  {
    name: "Tienda NewTelco San Jose Valley Fair",
    address: "2855 Stevens Creek Blvd, Santa Clara, CA",
    zip_code: "95050",
    phone: "(408) 555-2002",
    hours: "Lun-Sáb 10am-8pm, Dom 11am-6pm"
  },
  {
    name: "Tienda NewTelco Sacramento Midtown",
    address: "1801 L St, Sacramento, CA",
    zip_code: "95811",
    phone: "(916) 555-3003",
    hours: "Lun-Sáb 10am-7pm, Dom 12pm-5pm"
  },
  // SoCal
  {
    name: "Tienda NewTelco Los Angeles Hollywood",
    address: "6801 Hollywood Blvd, Los Angeles, CA",
    zip_code: "90028",
    phone: "(323) 555-4004",
    hours: "Lun-Sáb 10am-9pm, Dom 11am-7pm"
  },
  {
    name: "Tienda NewTelco San Diego Gaslamp",
    address: "555 5th Ave, San Diego, CA",
    zip_code: "92101",
    phone: "(619) 555-5005",
    hours: "Lun-Sáb 10am-8pm, Dom 11am-6pm"
  },
  {
    name: "Tienda NewTelco Irvine Spectrum",
    address: "670 Spectrum Center Dr, Irvine, CA",
    zip_code: "92618",
    phone: "(949) 555-6006",
    hours: "Lun-Sáb 10am-8pm, Dom 11am-6pm"
  },
  // Costa Este
  {
    name: "Tienda NewTelco Ciudad de Nueva York Midtown",
    address: "350 5th Ave, New York, NY",
    zip_code: "10118",
    phone: "(212) 555-7007",
    hours: "Lun-Sáb 9am-8pm, Dom 10am-6pm"
  },
  {
    name: "Tienda NewTelco Boston Back Bay",
    address: "800 Boylston St, Boston, MA",
    zip_code: "02199",
    phone: "(617) 555-8008",
    hours: "Lun-Sáb 10am-7pm, Dom 12pm-6pm"
  },
  {
    name: "Tienda NewTelco Washington DC Georgetown",
    address: "1234 Wisconsin Ave NW, Washington, DC",
    zip_code: "20007",
    phone: "(202) 555-9009",
    hours: "Lun-Sáb 10am-7pm, Dom 12pm-5pm"
  },
  {
    name: "Tienda NewTelco Miami Beach",
    address: "1601 Collins Ave, Miami Beach, FL",
    zip_code: "33139",
    phone: "(305) 555-1010",
    hours: "Lun-Sáb 10am-8pm, Dom 11am-6pm"
  }
];