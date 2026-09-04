import { z } from 'zod';

const isoDate = z.string().datetime({ offset: true });
const nonEmpty = z.string().min(1);

export const AttachmentSchema = z.object({
  id: nonEmpty.optional(),
  name: nonEmpty.optional(),
  type: nonEmpty.optional(),
  url: z.string().url().optional(),
}).strict();

export const ParticipantSchema = z.object({
  id: nonEmpty,
  entityUrn: nonEmpty.optional(),
  name: nonEmpty,
  profileUrl: z.string().url().optional(),
  headline: nonEmpty.optional(),
  company: nonEmpty.optional(),
  isSelf: z.boolean(),
  probablyRecruiter: z.boolean(),
  recruiterSignals: z.array(nonEmpty),
}).strict();

export const MessageSchema = z.object({
  id: nonEmpty,
  entityUrn: nonEmpty.optional(),
  conversationId: nonEmpty,
  senderId: nonEmpty,
  senderName: nonEmpty,
  senderProfileUrl: z.string().url().optional(),
  sentAt: isoDate.optional(),
  direction: z.enum(['inbound', 'outbound']),
  sequence: z.number().int().nonnegative(),
  text: z.string(),
  messageType: nonEmpty.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  sourceMetadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();

export const ConversationSchema = z.object({
  id: nonEmpty,
  entityUrn: nonEmpty.optional(),
  url: z.string().url().optional(),
  lastActivityAt: isoDate.optional(),
  participants: z.array(ParticipantSchema),
  messages: z.array(MessageSchema),
  sourceMetadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict();

export const ExportSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: isoDate,
  account: z.object({
    id: nonEmpty,
    entityUrn: nonEmpty.optional(),
    name: nonEmpty,
    profileUrl: z.string().url().optional(),
  }).strict(),
  stats: z.object({
    requestedConversationLimit: z.number().int().positive().max(500),
    exportedConversationCount: z.number().int().nonnegative(),
    exportedMessageCount: z.number().int().nonnegative(),
    partial: z.boolean(),
    warnings: z.array(nonEmpty),
  }).strict(),
  conversations: z.array(ConversationSchema),
}).strict().superRefine((data, context) => {
  const conversationIds = new Set<string>();
  for (const conversation of data.conversations) {
    if (conversationIds.has(conversation.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate conversation ID: ${conversation.id}` });
    conversationIds.add(conversation.id);
    const participantIds = new Set<string>();
    for (const participant of conversation.participants) {
      if (participantIds.has(participant.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate participant ID: ${participant.id}` });
      participantIds.add(participant.id);
      if (participant.isSelf && participant.id !== data.account.id) context.addIssue({ code: z.ZodIssueCode.custom, message: `Self participant does not match account: ${participant.id}` });
    }
    const messageIds = new Set<string>();
    for (const message of conversation.messages) {
      if (messageIds.has(message.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate message ID: ${message.id}` });
      messageIds.add(message.id);
      if (message.conversationId !== conversation.id) context.addIssue({ code: z.ZodIssueCode.custom, message: `Message conversation reference mismatch: ${message.id}` });
      const isAccount = message.senderId === data.account.id;
      if (!isAccount && !participantIds.has(message.senderId)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown message sender: ${message.id}` });
      if ((isAccount && message.direction !== 'outbound') || (!isAccount && message.direction !== 'inbound')) context.addIssue({ code: z.ZodIssueCode.custom, message: `Message direction mismatch: ${message.id}` });
    }
  }
});

export type Attachment = z.infer<typeof AttachmentSchema>;
export type Participant = z.infer<typeof ParticipantSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type Conversation = z.infer<typeof ConversationSchema>;
export type LinkedInExport = z.infer<typeof ExportSchema>;

export type RawParticipant = Partial<Omit<Participant, 'isSelf' | 'probablyRecruiter' | 'recruiterSignals'>> & {
  id?: string;
  isSelf?: boolean;
};
export type RawMessage = {
  id?: string;
  entityUrn?: string;
  conversationId?: string;
  senderId?: string;
  senderName?: string;
  senderProfileUrl?: string;
  sentAt?: string | number;
  direction?: 'inbound' | 'outbound';
  text?: string;
  messageType?: string;
  attachments?: Attachment[];
  sourceMetadata?: Record<string, string | number | boolean>;
  sourceOrder?: number;
};
export type RawConversation = {
  id?: string;
  entityUrn?: string;
  url?: string;
  lastActivityAt?: string | number;
  participants?: RawParticipant[];
  messages?: RawMessage[];
  sourceMetadata?: Record<string, string | number | boolean>;
};
