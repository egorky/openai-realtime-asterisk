import React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toolTemplates } from "@/lib/tool-templates";
import { BackendTag } from "./backend-tag";

interface ToolConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingIndex: number | null;
  selectedTemplate: string;
  editingSchemaStr: string;
  isJsonValid: boolean;
  onTemplateChange: (val: string) => void;
  onSchemaChange: (val: string) => void;
  onSave: () => void;
  backendTools: any[]; // schemas returned from the server
}

export const ToolConfigurationDialog: React.FC<
  ToolConfigurationDialogProps
> = ({
  open,
  onOpenChange,
  editingIndex,
  selectedTemplate,
  editingSchemaStr,
  isJsonValid,
  onTemplateChange,
  onSchemaChange,
  onSave,
  backendTools,
}) => {
  // Combine local templates and backend templates
  const localTemplateOptions = toolTemplates.map((template) => ({
    ...template,
    source: "local",
  }));

  const backendTemplateOptions = backendTools.map((t: any) => ({
    ...t,
    source: "backend",
  }));

  const allTemplates = [...localTemplateOptions, ...backendTemplateOptions];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editingIndex === null ? "Add Tool" : "Edit Tool"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <Select value={selectedTemplate} onValueChange={onTemplateChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select a template (optional)" />
            </SelectTrigger>
            <SelectContent>
              {allTemplates.map((template) => (
                <SelectItem key={template.name} value={template.name}>
                  <span className="flex items-center">
                    {template.name}
                    {template.source === "backend" && <BackendTag />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Textarea
            className="min-h-[200px] font-mono text-sm"
            value={editingSchemaStr}
            onChange={(e) => onSchemaChange(e.target.value)}
            placeholder="Enter tool JSON schema"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!isJsonValid}>
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
