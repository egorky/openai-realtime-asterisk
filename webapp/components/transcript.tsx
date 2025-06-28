import React, { useEffect, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, Phone, MessageSquare, Wrench } from "lucide-react";
import { Item } from "@/components/types";

type TranscriptProps = {
  items: Item[];
};

const Transcript: React.FC<TranscriptProps> = ({ items }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  // Show messages, function calls, and function call outputs in the transcript
  const transcriptItems = items.filter(
    (it) =>
      it.type === "message" ||
      it.type === "function_call" ||
      it.type === "function_call_output"
  );

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardContent className="flex-1 h-full min-h-0 overflow-hidden flex flex-col p-0">
        {transcriptItems.length === 0 && (
          <div className="flex flex-1 h-full items-center justify-center mt-36">
            <div className="flex flex-col items-center gap-3 justify-center h-full">
              <div className="h-[140px] w-[140px] rounded-full bg-secondary/20 flex items-center justify-center">
                <MessageSquare className="h-16 w-16 text-foreground/10 bg-transparent" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-sm font-medium text-foreground/60">
                  No messages yet
                </p>
                <p className="text-sm text-muted-foreground">
                  Start a call to see the transcript
                </p>
              </div>
            </div>
          </div>
        )}
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-6 p-6">
            {transcriptItems.map((msg, i) => {
              const isUser = msg.role === "user";
              const isTool = msg.role === "tool";
              // Default to assistant if not user or tool
              const Icon = isUser ? Phone : isTool ? Wrench : Bot;

              // Combine all text parts into a single string for display
              const displayText = msg.content
                ? msg.content.map((c) => c.text).join("")
                : "";

              return (
                <div key={i} className="flex items-start gap-3">
                  <div
                    className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center border ${
                      isUser
                        ? "bg-background border-border"
                        : isTool
                        ? "bg-secondary border-secondary"
                        : "bg-secondary border-secondary"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span
                        className={`text-sm font-medium ${
                          isUser ? "text-muted-foreground" : "text-foreground"
                        }`}
                      >
                        {isUser
                          ? "Caller"
                          : isTool
                          ? "Tool Response"
                          : "Assistant"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {msg.timestamp}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground leading-relaxed break-words">
                      {displayText}
                    </p>
                  </div>
                </div>
              );
            })}
            <div ref={scrollRef} />
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};

export default Transcript;
