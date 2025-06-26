// Este archivo (ari-client.ts) ahora actúa como un punto de entrada principal,
// re-exportando la funcionalidad principal desde ari-service.ts y otros módulos necesarios.

import {
    AriClientInterface,
    CallSpecificConfig,
    LoggerInstance,
    AppRecognitionConfig,
    DtmfConfig,
    OpenAIRealtimeAPIConfig,
    // RuntimeConfig no necesita ser exportado desde aquí si solo se usa internamente en ari-config.ts
} from './types';

import {
    CallResources,
    ActiveCallInfo
} from './ari-call-resources';

import {
    initializeAriClient,
    ariClientServiceInstance,
    // La clase AriClientService en sí misma no necesita ser exportada si solo se usa la instancia.
} from './ari-service';

// Re-exportar tipos y la instancia/inicializador para mantener la API del módulo original
// si otros archivos dependen de importar directamente desde 'ari-client.ts'.
export {
    initializeAriClient,
    ariClientServiceInstance,
    AriClientInterface,
    CallSpecificConfig,
    LoggerInstance,
    CallResources,
    ActiveCallInfo,
    AppRecognitionConfig,
    DtmfConfig,
    OpenAIRealtimeAPIConfig
};

// Las constantes de configuración (ASTERISK_ARI_URL, etc.) se importan directamente desde './ari-config' donde se necesiten.
// Las funciones de utilidad (getVar, getCallSpecificConfig) están en './ari-config'.
// El logger base (moduleLogger) está en './ari-logger'.
// La función createWavHeader está en './ari-utils'.
// La lógica detallada de la clase AriClientService (manejadores de eventos, acciones, limpieza)
// está siendo movida de ari-service.ts a los módulos específicos (ari-events.ts, ari-actions.ts, ari-cleanup.ts).

// Este archivo ya no contendrá la implementación masiva.
// Su propósito principal es ensamblar y exportar.
// La definición de la clase AriClientService ahora reside en ari-service.ts.
// Las funciones auxiliares y manejadores de eventos se están migrando a sus respectivos archivos.
// fs y path ya no son necesarios aquí directamente, se usarán en los módulos específicos.
// dotenv se carga en ari-service.ts o ari-config.ts.
// RtpServer, sessionManager, etc., son dependencias de ari-service.ts y otros módulos.
// Los imports de ari-client (Channel, Bridge, etc.) se usarán en los módulos donde sean necesarios.
import { Channel, Bridge, Playback } from 'ari-client'; // Re-exportar tipos comunes de ari-client si es necesario
export { Channel, Bridge, Playback }; // Opcional, dependiendo de si se usan externamente desde este módulo
