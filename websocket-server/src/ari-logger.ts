// Este archivo contendrá la lógica para la creación y gestión de instancias de logger.

import { CallSpecificConfig, LoggerInstance } from './types';
// Necesitaremos acceso a AriClientService para getActiveCallResource si el logger lo usa directamente.
// Esto podría ser una dependencia circular si AriClientService también importa de aquí.
// Alternativamente, la información de la llamada (ID, callerId) podría pasarse explícitamente al logger.
// Por ahora, asumimos que getActiveCallResource se pasará o se manejará de otra manera.
// import { ariClientServiceInstance } from './ari-service'; // CUIDADO: Posible dependencia circular

// Definición de la función para obtener el logger principal del módulo.
// Esta es una IIFE (Immediately Invoked Function Expression) que crea y configura el logger.
export const moduleLogger: LoggerInstance = (() => {
  const loggerInstance: any = {}; // Usamos 'any' temporalmente para facilitar la construcción.
  const levels: { [key: string]: number } = { silly: 0, debug: 1, info: 2, warn: 3, error: 4 };

  // Esta función necesita una forma de acceder a la configuración actual de la llamada o la base.
  // Si ariClientServiceInstance no está disponible aquí, getEffectiveLogLevel necesitará
  // que se le pase la configuración o que se obtenga de otra manera.
  const getEffectiveLogLevel = (configForLevel?: CallSpecificConfig /*| RuntimeConfig*/): string => {
    // const conf = configForLevel || currentCallSpecificConfig || baseConfig; // currentCallSpecificConfig y baseConfig no están aquí
    // Provisionalmente, usamos un valor por defecto o process.env.LOG_LEVEL
    // La implementación final necesitará acceso a la configuración.
    const conf = configForLevel;
    return process.env.LOG_LEVEL?.toLowerCase() || conf?.logging?.level || 'info';
  };

  loggerInstance.isLevelEnabled = (level: string, configOverride?: CallSpecificConfig): boolean => {
    const effectiveLogLevel = getEffectiveLogLevel(configOverride);
    const configuredLevelNum = levels[effectiveLogLevel] ?? levels.info;
    return levels[level] >= configuredLevelNum;
  };

  const formatLogMessage = (level: string, bindings: any, ariClientServiceRef: any, ...args: any[]): void => {
    // El parámetro ariClientServiceRef es una referencia pasada para evitar la dependencia circular directa.
    if (!loggerInstance.isLevelEnabled(level, bindings.configOverride)) {
      return;
    }

    const timestamp = new Date().toISOString();
    let effectiveCallId = bindings.callId || 'System';
    let displayCallerId = bindings.callerId || 'N/A';

    if (bindings.callId && ariClientServiceRef) {
        const callResource = ariClientServiceRef.getActiveCallResource(bindings.callId);
        if (callResource && callResource.channel) {
            effectiveCallId = callResource.channel.id;
            if (callResource.channel.caller && callResource.channel.caller.number) {
                displayCallerId = callResource.channel.caller.number;
            } else if (displayCallerId === 'N/A') {
                displayCallerId = callResource.channel.name;
            }
        }
    }

    const prefixParts: string[] = [];
    if (bindings.service) prefixParts.push(`service=${bindings.service}`);
    if (bindings.component) prefixParts.push(`component=${bindings.component}`);

    const mainPrefix = `[${timestamp}] [uid:${effectiveCallId}] [cnum:${displayCallerId}]`;
    const contextPrefix = prefixParts.length > 0 ? ` [${prefixParts.join(' ')}]` : '';

    let logFunction: (...args: any[]) => void;
    switch (level) {
      case 'silly': logFunction = console.debug; break;
      case 'debug': logFunction = console.debug; break;
      case 'warn': logFunction = console.warn; break;
      case 'error': logFunction = console.error; break;
      case 'info': default: logFunction = console.info; break;
    }

    if (args.length > 0 && typeof args[0] === 'string') {
      logFunction(`${mainPrefix}${contextPrefix} ${args[0]}`, ...args.slice(1));
    } else {
      logFunction(`${mainPrefix}${contextPrefix}`, ...args);
    }
  };

  (['info', 'error', 'warn', 'debug', 'silly'] as const).forEach(levelKey => {
    loggerInstance[levelKey] = (...args: any[]) => {
      // Para el logger de nivel superior, los bindings son mínimos.
      // Se necesita una referencia a ariClientServiceInstance que se pasará en el momento de la creación del logger hijo
      // o a través de un setter. Por ahora, pasamos null o un objeto mock.
      // Esto es un punto clave a resolver en la refactorización.
      // Una solución es que el AriClientService inyecte una referencia a sí mismo en el logger
      // o que el logger reciba las funciones necesarias para obtener datos de la llamada.
      formatLogMessage(levelKey, {}, null /* ariClientServiceRef placeholder */, ...args);
    };
  });

  loggerInstance.child = (bindings: object, callSpecificLogLevel?: string, ariClientServiceRef?: any): LoggerInstance => {
    const childLogger: any = {};
    const currentBindings = { ...bindings } as any;

    if (callSpecificLogLevel) {
        currentBindings.configOverride = { logging: { level: callSpecificLogLevel } } as CallSpecificConfig;
    }

    childLogger.isLevelEnabled = (level: string): boolean => {
      const levelsMap: { [key: string]: number } = { silly: 0, debug: 1, info: 2, warn: 3, error: 4 };
      const effectiveCallLogLevel = callSpecificLogLevel || getEffectiveLogLevel(currentBindings.configOverride);
      const configuredLevelNum = levelsMap[effectiveCallLogLevel] ?? levelsMap.info;
      return levelsMap[level] >= configuredLevelNum;
    };

    (['info', 'error', 'warn', 'debug', 'silly'] as const).forEach(levelKey => {
      childLogger[levelKey] = (...args: any[]) => {
        // Pasar la referencia a ariClientServiceRef que se recibió al crear el logger hijo.
        formatLogMessage(levelKey, currentBindings, ariClientServiceRef, ...args);
      };
    });

    childLogger.child = (newChildBindings: object, newChildCallSpecificLogLevel?: string, newAriClientServiceRef?: any): LoggerInstance => {
      const mergedBindings = {...currentBindings, ...newChildBindings};
      // El logger hijo hereda la referencia a ariClientServiceRef de su padre si no se proporciona una nueva.
      return loggerInstance.child(mergedBindings, newChildCallSpecificLogLevel || callSpecificLogLevel, newAriClientServiceRef || ariClientServiceRef);
    };
    return childLogger as LoggerInstance;
  };
  return loggerInstance as LoggerInstance;
})();

// Nota: La dependencia de `ariClientServiceInstance` en `formatLogMessage` y en la creación de `child` loggers
// Nota: La gestión de `ariClientServiceRef` es clave.
// AriClientService crea su logger principal usando:
// `this.logger = baseModuleLogger.child({ service: 'AriClientService' }, undefined, this);`
// `baseModuleLogger` es el `moduleLogger` exportado aquí.
// Este `ariClientServiceRef` (que es `this` de AriClientService) se propaga a los loggers hijos,
// permitiendo que `formatLogMessage` acceda a `getActiveCallResource` para enriquecer los logs.
