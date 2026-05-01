export type Role = 'user' | 'model';

export interface Attachment {
  mimeType: string;
  data: string; // Base64
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: any; // Firestore Timestamp
  attachment?: Attachment;
}

export interface Chat {
  id: string;
  title: string;
  userId: string;
  createdAt: any;
  updatedAt: any;
  model: string;
  temperature: number;
  maxTokens: number;
}
