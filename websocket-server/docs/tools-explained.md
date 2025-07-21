# Herramientas Disponibles

Este documento detalla todas las herramientas (tools) que los agentes de IA pueden utilizar, cómo funcionan y qué parámetros aceptan.

## 1. `get_weather_from_coords`

*   **Descripción**: Obtiene el clima actual para una ubicación geográfica específica utilizando coordenadas de latitud y longitud.
*   **Parámetros**:
    *   `latitude` (number, requerido): La latitud de la ubicación.
    *   `longitude` (number, requerido): La longitud de la ubicación.
*   **Devuelve**: Un objeto JSON con la temperatura actual. Ejemplo: `{"temp": 25}`.
*   **Implementación**: Llama a la API de Open-Meteo.

## 2. `get_available_slots`

*   **Descripción**: Devuelve una lista de horarios disponibles para una cita, basándose en la especialidad, ciudad y sucursal.
*   **Parámetros**:
    *   `specialty` (string, requerido): La especialidad médica para la cita.
    *   `city` (string, requerido): La ciudad donde se solicita la cita.
    *   `branch` (string, requerido): La sucursal o centro médico.
*   **Devuelve**: Un objeto JSON con una lista de horarios disponibles. Ejemplo: `{"slots":["Mañana, ... a las 9:00 AM", "Mañana, ... a las 11:30 AM"]}`.
*   **Implementación**: Actualmente devuelve datos de ejemplo. En una aplicación real, consultaría una base de datos o una API de agendamiento.

## 3. `scheduleAppointment`

*   **Descripción**: Agenda una cita para un usuario en un horario específico.
*   **Parámetros**:
    *   `identificationNumber` (string, requerido): El número de identificación del paciente.
    *   `specialty` (string, requerido): La especialidad médica.
    *   `city` (string, requerido): La ciudad de la cita.
    *   `branch` (string, requerido): La sucursal de la cita.
    *   `slot` (string, requerido): El horario seleccionado de la lista de disponibles.
*   **Devuelve**: Un objeto JSON indicando si la operación fue exitosa. Ejemplo: `{"success": true}`.
*   **Implementación**: Simula la creación de una cita. En producción, interactuaría con un sistema de gestión de citas.

## 4. `endCall`

*   **Descripción**: Finaliza la llamada telefónica actual. Esta herramienta es fundamental para que el agente pueda colgar la llamada de forma proactiva una vez que la conversación ha concluido.
*   **Parámetros**: Ninguno.
*   **Devuelve**: Un objeto JSON indicando el éxito de la operación. Ejemplo: `{"success": true, "message": "Call termination initiated."}`.
*   **Implementación**: Esta herramienta es especial. Cuando es invocada, el `toolExecutor.ts` llama directamente al método `endCall` del `ari-service.ts`, que a su vez envía el comando a Asterisk para colgar el canal de la llamada.
*   **Instrucciones para el Agente**: Para usar esta herramienta correctamente, el agente debe ser instruido para invocarla al final de la conversación. Por ejemplo: *"Cuando el usuario confirme que no tiene más preguntas, despídete y usa la herramienta `endCall`."*
