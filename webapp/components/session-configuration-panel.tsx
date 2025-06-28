import React, { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Plus, Edit, Trash, Check, AlertCircle } from "lucide-react";
import { toolTemplates } from "@/lib/tool-templates";
import { ToolConfigurationDialog } from "./tool-configuration-dialog";
import { BackendTag } from "./backend-tag";
import { useBackendTools } from "@/lib/use-backend-tools";

import { Label } from "@/components/ui/label"; // Asegúrate que Label esté importado
import { Input } from "@/components/ui/input";   // Asegúrate que Input esté importado
import { Checkbox } from "@/components/ui/checkbox"; // Asegúrate que Checkbox esté importado
import { CallSpecificConfig, AppRecognitionConfig, DtmfConfig, OpenAIRealtimeAPIConfig } from "./types"; // Asumiendo que estos tipos se pueden importar o definir aquí


interface SessionConfigurationPanelProps {
  callStatus: string;
  selectedCallId: string | null;
  onSave: (config: any) => void; // config será más específico
  ws: WebSocket | null; // Necesitamos el WebSocket para enviar 'get_call_configuration'
}

const SessionConfigurationPanel: React.FC<SessionConfigurationPanelProps> = ({
  callStatus,
  selectedCallId,
  onSave,
  ws,
}) => {
  // Estados para OpenAIRealtimeAPIConfig
  const [instructions, setInstructions] = useState("You are a helpful assistant in a phone call.");
  const [ttsVoice, setTtsVoice] = useState("alloy");
  const [model, setModel] = useState("gpt-4o-mini-realtime-preview-2024-12-17");
  const [tools, setTools] = useState<string[]>([]);

  // Estados para AppRecognitionConfig
  const [recognitionActivationMode, setRecognitionActivationMode] = useState<AppRecognitionConfig['recognitionActivationMode']>('fixedDelay');
  const [bargeInDelaySeconds, setBargeInDelaySeconds] = useState<number>(0.2);
  const [noSpeechBeginTimeoutSeconds, setNoSpeechBeginTimeoutSeconds] = useState<number>(5.0);
  const [speechEndSilenceTimeoutSeconds, setSpeechEndSilenceTimeoutSeconds] = useState<number>(1.5);
  const [maxRecognitionDurationSeconds, setMaxRecognitionDurationSeconds] = useState<number>(30.0);
  const [vadRecogActivation, setVadRecogActivation] = useState<AppRecognitionConfig['vadRecogActivation']>('vadMode');
  const [vadInitialSilenceDelaySeconds, setVadInitialSilenceDelaySeconds] = useState<number>(0.0);
  const [vadMaxWaitAfterPromptSeconds, setVadMaxWaitAfterPromptSeconds] = useState<number>(10.0);
  const [vadSilenceThresholdMs, setVadSilenceThresholdMs] = useState<number>(2500);
  const [vadTalkThreshold, setVadTalkThreshold] = useState<number>(256);

  // Estados para DtmfConfig
  const [enableDtmfRecognition, setEnableDtmfRecognition] = useState<boolean>(true);
  const [dtmfInterDigitTimeoutSeconds, setDtmfInterDigitTimeoutSeconds] = useState<number>(3.0);
  const [dtmfFinalTimeoutSeconds, setDtmfFinalTimeoutSeconds] = useState<number>(5.0);

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingSchemaStr, setEditingSchemaStr] = useState("");
  const [isJsonValid, setIsJsonValid] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const websocketServerBaseUrl = process.env.NEXT_PUBLIC_WEBSOCKET_SERVER_BASE_URL;
  const toolsUrl = websocketServerBaseUrl ? `${websocketServerBaseUrl}/tools` : "";
  const backendTools = useBackendTools(toolsUrl, 3000);

  // Efecto para cargar configuración cuando selectedCallId cambia o ws se conecta
  useEffect(() => {
    if (selectedCallId && ws && ws.readyState === WebSocket.OPEN) {
      console.log(`Requesting configuration for callId: ${selectedCallId}`);
      ws.send(JSON.stringify({ type: "get_call_configuration", callId: selectedCallId }));
      setSaveStatus("idle");
      setHasUnsavedChanges(false);
    } else if (!selectedCallId) {
      // Resetear campos a default si no hay llamada seleccionada
      setInstructions("You are a helpful assistant in a phone call.");
      setTtsVoice("alloy");
      setModel("gpt-4o-mini-realtime-preview-2024-12-17");
      setTools([]);
      setRecognitionActivationMode('fixedDelay');
      setBargeInDelaySeconds(0.2);
      setNoSpeechBeginTimeoutSeconds(5.0);
      setSpeechEndSilenceTimeoutSeconds(1.5);
      setMaxRecognitionDurationSeconds(30.0);
      setVadRecogActivation('vadMode');
      setVadInitialSilenceDelaySeconds(0.0);
      setVadMaxWaitAfterPromptSeconds(10.0);
      setVadSilenceThresholdMs(2500);
      setVadTalkThreshold(256);
      setEnableDtmfRecognition(true);
      setDtmfInterDigitTimeoutSeconds(3.0);
      setDtmfFinalTimeoutSeconds(5.0);
      setHasUnsavedChanges(false);
      setSaveStatus("idle");
    }
  }, [selectedCallId, ws]);

  // Efecto para manejar la recepción de la configuración de la llamada
  useEffect(() => {
    if (ws) {
      const messageHandler = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.type === "call_configuration" && data.callId === selectedCallId && data.payload) {
            console.log(`Received configuration for call ${data.callId}:`, data.payload);
            const config = data.payload as CallSpecificConfig;

            // OpenAI Config
            setInstructions(config.openAIRealtimeAPI.instructions || "You are a helpful assistant.");
            setTtsVoice(config.openAIRealtimeAPI.ttsVoice || "alloy");
            setModel(config.openAIRealtimeAPI.model || "gpt-4o-mini-realtime-preview-2024-12-17");
            setTools(config.openAIRealtimeAPI.tools?.map(t => JSON.stringify(t, null, 2)) || []);

            // AppRecognitionConfig
            const arc = config.appConfig.appRecognitionConfig;
            setRecognitionActivationMode(arc.recognitionActivationMode || 'fixedDelay');
            setBargeInDelaySeconds(arc.bargeInDelaySeconds !== undefined ? arc.bargeInDelaySeconds : 0.2);
            setNoSpeechBeginTimeoutSeconds(arc.noSpeechBeginTimeoutSeconds !== undefined ? arc.noSpeechBeginTimeoutSeconds : 5.0);
            setSpeechEndSilenceTimeoutSeconds(arc.speechEndSilenceTimeoutSeconds !== undefined ? arc.speechEndSilenceTimeoutSeconds : 1.5);
            setMaxRecognitionDurationSeconds(arc.maxRecognitionDurationSeconds !== undefined ? arc.maxRecognitionDurationSeconds : 30.0);
            setVadRecogActivation(arc.vadRecogActivation || 'vadMode');
            setVadInitialSilenceDelaySeconds(arc.vadInitialSilenceDelaySeconds !== undefined ? arc.vadInitialSilenceDelaySeconds : 0.0);
            setVadMaxWaitAfterPromptSeconds(arc.vadMaxWaitAfterPromptSeconds !== undefined ? arc.vadMaxWaitAfterPromptSeconds : 10.0);
            setVadSilenceThresholdMs(arc.vadSilenceThresholdMs !== undefined ? arc.vadSilenceThresholdMs : 2500);
            setVadTalkThreshold(arc.vadTalkThreshold !== undefined ? arc.vadTalkThreshold : 256);

            // DtmfConfig
            const dtmf = config.appConfig.dtmfConfig;
            setEnableDtmfRecognition(dtmf.enableDtmfRecognition !== undefined ? dtmf.enableDtmfRecognition : true);
            setDtmfInterDigitTimeoutSeconds(dtmf.dtmfInterDigitTimeoutSeconds !== undefined ? dtmf.dtmfInterDigitTimeoutSeconds : 3.0);
            setDtmfFinalTimeoutSeconds(dtmf.dtmfFinalTimeoutSeconds !== undefined ? dtmf.dtmfFinalTimeoutSeconds : 5.0);

            setHasUnsavedChanges(false);
            setSaveStatus("idle");
          }
        } catch (error) {
          console.error("Error parsing message or setting config in SessionConfigurationPanel:", error);
        }
      };
      ws.addEventListener('message', messageHandler);
      return () => {
        ws.removeEventListener('message', messageHandler);
      };
    }
  }, [ws, selectedCallId]);

  const initialLoadRef = React.useRef(true);
  useEffect(() => {
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      setHasUnsavedChanges(false); // Don't mark as unsaved on initial load
      return;
    }
    setHasUnsavedChanges(true);
  }, [
    instructions, ttsVoice, model, tools,
    recognitionActivationMode, bargeInDelaySeconds, noSpeechBeginTimeoutSeconds, speechEndSilenceTimeoutSeconds, maxRecognitionDurationSeconds,
    vadRecogActivation, vadInitialSilenceDelaySeconds, vadMaxWaitAfterPromptSeconds, vadSilenceThresholdMs, vadTalkThreshold,
    enableDtmfRecognition, dtmfInterDigitTimeoutSeconds, dtmfFinalTimeoutSeconds
  ]);


  // Reset save status after a delay when saved
  useEffect(() => {
    if (saveStatus === "saved") {
      const timer = setTimeout(() => {
        setSaveStatus("idle");
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  const handleSave = async () => {
    setSaveStatus("saving");
    try {
      await onSave({
        instructions,
        ttsVoice, // Cambiado de 'voice' a 'ttsVoice'
        tools: tools.map((tool) => JSON.parse(tool)),
      });
      setSaveStatus("saved");
      setHasUnsavedChanges(false);
    } catch (error) {
      setSaveStatus("error");
    }
  };

  const handleAddTool = () => {
    setEditingIndex(null);
    setEditingSchemaStr("");
    setSelectedTemplate("");
    setIsJsonValid(true);
    setOpenDialog(true);
  };

  const handleEditTool = (index: number) => {
    setEditingIndex(index);
    setEditingSchemaStr(tools[index] || "");
    setSelectedTemplate("");
    setIsJsonValid(true);
    setOpenDialog(true);
  };

  const handleDeleteTool = (index: number) => {
    const newTools = [...tools];
    newTools.splice(index, 1);
    setTools(newTools);
  };

  const handleDialogSave = () => {
    try {
      JSON.parse(editingSchemaStr);
    } catch {
      return;
    }
    const newTools = [...tools];
    if (editingIndex === null) {
      newTools.push(editingSchemaStr);
    } else {
      newTools[editingIndex] = editingSchemaStr;
    }
    setTools(newTools);
    setOpenDialog(false);
  };

  const handleTemplateChange = (val: string) => {
    setSelectedTemplate(val);

    // Determine if the selected template is from local or backend
    let templateObj =
      toolTemplates.find((t) => t.name === val) ||
      backendTools.find((t: any) => t.name === val);

    if (templateObj) {
      setEditingSchemaStr(JSON.stringify(templateObj, null, 2));
      setIsJsonValid(true);
    }
  };

  const onSchemaChange = (value: string) => {
    setEditingSchemaStr(value);
    try {
      JSON.parse(value);
      setIsJsonValid(true);
    } catch {
      setIsJsonValid(false);
    }
  };

  const getToolNameFromSchema = (schema: string): string => {
    try {
      const parsed = JSON.parse(schema);
      return parsed?.name || "Untitled Tool";
    } catch {
      return "Invalid JSON";
    }
  };

  const isBackendTool = (name: string): boolean => {
    return backendTools.some((t: any) => t.name === name);
  };

  return (
    <Card className="flex flex-col h-full w-full mx-auto">
      <CardHeader className="pb-0 px-4 sm:px-6">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">
            Session Configuration
          </CardTitle>
          <div className="flex items-center gap-2">
            {saveStatus === "error" ? (
              <span className="text-xs text-red-500 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                Save failed
              </span>
            ) : hasUnsavedChanges ? (
              <span className="text-xs text-muted-foreground">Not saved</span>
            ) : (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Check className="h-3 w-3" />
                Saved
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 p-3 sm:p-5">
        <ScrollArea className="h-full">
          <div className="space-y-4 sm:space-y-6 m-1">
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">
                Instructions
              </label>
              <Textarea
                placeholder="Enter instructions"
                className="min-h-[100px] resize-none"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Voice (TTS)</label>
              <Select value={ttsVoice} onValueChange={setTtsVoice}> {/* Cambiado de 'voice' a 'ttsVoice' */}
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select voice" />
                </SelectTrigger>
                <SelectContent>
                  {/* Voces de OpenAI Realtime API */}
                  {["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model Selection */}
            <div className="space-y-2">
              <Label htmlFor="openai-model-select">OpenAI Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="openai-model-select" className="w-full">
                  <SelectValue placeholder="Select OpenAI model" />
                </SelectTrigger>
                <SelectContent>
                  {/* Estos son ejemplos, idealmente vendrían del backend o una lista más completa */}
                  <SelectItem value="gpt-4o-mini-realtime-preview-2024-12-17">gpt-4o-mini-realtime-preview-2024-12-17</SelectItem>
                  <SelectItem value="gpt-4o-realtime-preview-2024-07-01">gpt-4o-realtime-preview-2024-07-01</SelectItem>
                  <SelectItem value="gpt-4-turbo">gpt-4-turbo (No Realtime)</SelectItem>
                  <SelectItem value="gpt-3.5-turbo">gpt-3.5-turbo (No Realtime)</SelectItem>
                </SelectContent>
              </Select>
            </div>


            {/* Recognition Activation Mode */}
            <div className="space-y-2">
              <Label htmlFor="recog-activation-mode">Recognition Activation Mode</Label>
              <Select value={recognitionActivationMode} onValueChange={value => setRecognitionActivationMode(value as AppRecognitionConfig['recognitionActivationMode'])}>
                <SelectTrigger id="recog-activation-mode" className="w-full">
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixedDelay">Fixed Delay</SelectItem>
                  <SelectItem value="Immediate">Immediate</SelectItem>
                  <SelectItem value="vad">VAD (Voice Activity Detection)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {recognitionActivationMode === 'fixedDelay' && (
              <div className="space-y-2 pl-4 border-l-2 border-gray-200 ml-1">
                <Label htmlFor="barge-in-delay">Barge-In Delay (seconds)</Label>
                <Input id="barge-in-delay" type="number" step="0.1" value={bargeInDelaySeconds} onChange={e => setBargeInDelaySeconds(parseFloat(e.target.value))} placeholder="e.g., 0.5" />
              </div>
            )}

            {recognitionActivationMode === 'vad' && (
              <div className="space-y-4 pl-4 border-l-2 border-gray-200 ml-1">
                <div className="space-y-2">
                  <Label htmlFor="vad-recog-activation">VAD Recognition Activation</Label>
                  <Select value={vadRecogActivation} onValueChange={value => setVadRecogActivation(value as AppRecognitionConfig['vadRecogActivation'])}>
                    <SelectTrigger id="vad-recog-activation" className="w-full">
                      <SelectValue placeholder="Select VAD activation" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="vadMode">VAD Mode (Detects during/after initial silence)</SelectItem>
                      <SelectItem value="afterPrompt">After Prompt (Detects after prompt finishes)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {vadRecogActivation === 'vadMode' && (
                  <div className="space-y-2 pl-4 border-l-2 border-gray-200 ml-1">
                    <Label htmlFor="vad-initial-silence">VAD Initial Silence Delay (s)</Label>
                    <Input id="vad-initial-silence" type="number" step="0.1" value={vadInitialSilenceDelaySeconds} onChange={e => setVadInitialSilenceDelaySeconds(parseFloat(e.target.value))} placeholder="e.g., 0.5" />
                  </div>
                )}
                 <div className="space-y-2">
                    <Label htmlFor="vad-max-wait-prompt">VAD Max Wait After Prompt (s)</Label>
                    <Input id="vad-max-wait-prompt" type="number" step="0.1" value={vadMaxWaitAfterPromptSeconds} onChange={e => setVadMaxWaitAfterPromptSeconds(parseFloat(e.target.value))} placeholder="e.g., 5.0" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vad-silence-thresh">VAD Silence Threshold (ms)</Label>
                    <Input id="vad-silence-thresh" type="number" step="100" value={vadSilenceThresholdMs} onChange={e => setVadSilenceThresholdMs(parseInt(e.target.value))} placeholder="e.g., 2500" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="vad-talk-thresh">VAD Talk Threshold (energy)</Label>
                    <Input id="vad-talk-thresh" type="number" step="10" value={vadTalkThreshold} onChange={e => setVadTalkThreshold(parseInt(e.target.value))} placeholder="e.g., 256" />
                  </div>
              </div>
            )}

            {/* General Speech Timers (apply if not DTMF only) */}
            <div className="space-y-2">
                <Label className="text-sm font-medium leading-none">Speech Timers (OpenAI)</Label>
                <div className="pl-4 border-l-2 border-gray-200 ml-1 space-y-2">
                    <div>
                        <Label htmlFor="no-speech-begin">No Speech Begin Timeout (s)</Label>
                        <Input id="no-speech-begin" type="number" step="0.1" value={noSpeechBeginTimeoutSeconds} onChange={e => setNoSpeechBeginTimeoutSeconds(parseFloat(e.target.value))} placeholder="e.g., 5.0" />
                    </div>
                    <div>
                        <Label htmlFor="speech-end-silence">Speech End Silence Timeout (s)</Label>
                        <Input id="speech-end-silence" type="number" step="0.1" value={speechEndSilenceTimeoutSeconds} onChange={e => setSpeechEndSilenceTimeoutSeconds(parseFloat(e.target.value))} placeholder="e.g., 1.5" />
                    </div>
                    <div>
                        <Label htmlFor="max-recog-duration">Max Recognition Duration (s)</Label>
                        <Input id="max-recog-duration" type="number" step="1" value={maxRecognitionDurationSeconds} onChange={e => setMaxRecognitionDurationSeconds(parseInt(e.target.value))} placeholder="e.g., 30" />
                    </div>
                </div>
            </div>

            {/* DTMF Configuration */}
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox id="enable-dtmf" checked={enableDtmfRecognition} onCheckedChange={checked => setEnableDtmfRecognition(Boolean(checked))} />
                <Label htmlFor="enable-dtmf" className="text-sm font-medium leading-none">Enable DTMF Recognition</Label>
              </div>
              {enableDtmfRecognition && (
                <div className="pl-4 border-l-2 border-gray-200 ml-1 space-y-2">
                  <div>
                    <Label htmlFor="dtmf-interdigit-timeout">DTMF Inter-Digit Timeout (s)</Label>
                    <Input id="dtmf-interdigit-timeout" type="number" step="0.1" value={dtmfInterDigitTimeoutSeconds} onChange={e => setDtmfInterDigitTimeoutSeconds(parseFloat(e.target.value))} placeholder="e.g., 3.0" />
                  </div>
                  <div>
                    <Label htmlFor="dtmf-final-timeout">DTMF Final Timeout (s)</Label>
                    <Input id="dtmf-final-timeout" type="number" step="0.1" value={dtmfFinalTimeoutSeconds} onChange={e => setDtmfFinalTimeoutSeconds(parseFloat(e.target.value))} placeholder="e.g., 5.0" />
                  </div>
                </div>
              )}
            </div>


            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Tools</label>
              <div className="space-y-2">
                {tools.map((tool, index) => {
                  const name = getToolNameFromSchema(tool);
                  const backend = isBackendTool(name);
                  return (
                    <div
                      key={index}
                      className="flex items-center justify-between rounded-md border p-2 sm:p-3 gap-2"
                    >
                      <span className="text-sm truncate flex-1 min-w-0 flex items-center">
                        {name}
                        {backend && <BackendTag />}
                      </span>
                      <div className="flex gap-1 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleEditTool(index)}
                          className="h-8 w-8"
                        >
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteTool(index)}
                          className="h-8 w-8"
                        >
                          <Trash className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleAddTool}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Tool
                </Button>
              </div>
            </div>

            <Button
              className="w-full mt-4"
              onClick={handleSave}
              disabled={saveStatus === "saving" || !hasUnsavedChanges || !selectedCallId}
            >
              {saveStatus === "saving"
                ? "Saving..."
                : saveStatus === "saved"
                ? "Saved Successfully"
                : saveStatus === "error"
                ? "Error Saving"
                : !selectedCallId
                ? "Select a Call to Configure"
                : "Save Configuration"}
            </Button>
          </div>
        </ScrollArea>
      </CardContent>

      <ToolConfigurationDialog
        open={openDialog}
        onOpenChange={setOpenDialog}
        editingIndex={editingIndex}
        selectedTemplate={selectedTemplate}
        editingSchemaStr={editingSchemaStr}
        isJsonValid={isJsonValid}
        onTemplateChange={handleTemplateChange}
        onSchemaChange={onSchemaChange}
        onSave={handleDialogSave}
        backendTools={backendTools}
      />
    </Card>
  );
};

export default SessionConfigurationPanel;
