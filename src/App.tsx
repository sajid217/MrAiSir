import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Plus, 
  Settings, 
  Moon, 
  Sun, 
  Menu, 
  X, 
  Send, 
  Mic, 
  Volume2, 
  Image as ImageIcon,
  LogOut,
  User,
  PanelLeftClose,
  PanelLeft
} from 'lucide-react';
import { 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  onSnapshot, 
  query, 
  where, 
  orderBy, 
  serverTimestamp,
  getDocs,
  limit
} from 'firebase/firestore';
import { auth, db, signIn, signOut, handleFirestoreError, OperationType } from './lib/firebase';
import { streamGeminiResponse, generateChatTitle } from './lib/gemini';
import { Chat, Message, Role } from './types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

export default function App() {
  const [user, setUser] = useState(auth.currentUser);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [attachment, setAttachment] = useState<{ mimeType: string, data: string } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<any>(null);
  
  // Settings
  const [selectedModel, setSelectedModel] = useState('gemini-3-flash-preview');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2000);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => {
      setUser(u);
      if (!u) {
        setChats([]);
        setActiveChatId(null);
        setMessages([]);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // Fetch Chats
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'chats'),
      where('userId', '==', user.uid),
      orderBy('updatedAt', 'desc')
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const chatData = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Chat));
      setChats(chatData);
    }, (err) => handleFirestoreError(err, OperationType.GET, 'chats'));
    return unsub;
  }, [user]);

  // Fetch Messages
  useEffect(() => {
    if (!activeChatId) {
      setMessages([]);
      return;
    }
    const q = query(
      collection(db, `chats/${activeChatId}/messages`),
      orderBy('createdAt', 'asc')
    );
    const unsub = onSnapshot(q, (snapshot) => {
      const msgData = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Message));
      setMessages(msgData);
    }, (err) => handleFirestoreError(err, OperationType.GET, `chats/${activeChatId}/messages`));
    return unsub;
  }, [activeChatId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const handleNewChat = async () => {
    if (!user) return;
    try {
      const docRef = await addDoc(collection(db, 'chats'), {
        title: 'New Chat',
        userId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        model: selectedModel,
        temperature,
        maxTokens
      });
      setActiveChatId(docRef.id);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'chats');
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() && !attachment) return;
    if (!user) {
      toast.error("Please sign in first");
      return;
    }

    let chatId = activeChatId;
    if (!chatId) {
      const docRef = await addDoc(collection(db, 'chats'), {
        title: 'New Chat',
        userId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        model: selectedModel,
        temperature,
        maxTokens
      });
      chatId = docRef.id;
      setActiveChatId(chatId);
    }

    const userMessage = input;
    const currentAttachment = attachment;
    setInput('');
    setAttachment(null);

    try {
      // Add user message
      await addDoc(collection(db, `chats/${chatId}/messages`), {
        role: 'user',
        content: userMessage,
        createdAt: serverTimestamp(),
        ...(currentAttachment && { attachment: currentAttachment })
      });

      // Update chat title if it's the first message
      if (messages.length === 0) {
        const title = await generateChatTitle(userMessage);
        await updateDoc(doc(db, 'chats', chatId), { 
          title,
          updatedAt: serverTimestamp() 
        });
      }

      setIsTyping(true);

      // Prepare history for Gemini
      // SDK expects: { role: 'user' | 'model', parts: [{ text: string }] }[]
      const history = messages.map(m => ({
        role: m.role,
        parts: [{ text: m.content }]
      }));

      let fullAIResponse = '';
      const aiResponseStream = streamGeminiResponse(
        selectedModel,
        history,
        userMessage,
        currentAttachment || undefined,
        { temperature, maxTokens }
      );

      // We'll update a temporary state for the streaming effect before persisting
      // Actually, for multi-turn and persistence, we can add a draft doc or just wait.
      // Let's create an empty model message first and update it.
      const docRef = await addDoc(collection(db, `chats/${chatId}/messages`), {
        role: 'model',
        content: '',
        createdAt: serverTimestamp(),
      });

      for await (const chunk of aiResponseStream) {
        fullAIResponse += chunk;
        await updateDoc(doc(db, `chats/${chatId}/messages`, docRef.id), {
          content: fullAIResponse
        });
      }

      await updateDoc(doc(db, 'chats', chatId), { updatedAt: serverTimestamp() });
    } catch (err) {
      toast.error("Message failed to send");
      console.error(err);
    } finally {
      setIsTyping(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setAttachment({
          mimeType: file.type,
          data: (reader.result as string).split(',')[1]
        });
      };
      reader.readAsDataURL(file);
    }
  };

  const toggleVoice = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      toast.error("Speech recognition not supported in this browser.");
      return;
    }

    if (isRecording) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      setIsRecording(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsRecording(true);
        toast.info("Listening...", { id: "voice-toast", duration: 2000 });
      };
      
      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        if (transcript) {
          setInput(prev => {
            const lastChar = prev.trim().slice(-1);
            const needsSpace = prev.length > 0 && lastChar !== ' ';
            return (prev.trim() + (needsSpace ? ' ' : '') + transcript).trim();
          });
        }
      };

      recognition.onerror = (event: any) => {
        console.error("Speech recognition error:", event.error);
        setIsRecording(false);
        if (event.error !== 'no-speech') {
          toast.error(`Speech error: ${event.error}`, { id: "voice-toast" });
        }
      };

      recognition.onend = () => {
        setIsRecording(false);
      };

      recognition.start();
    } catch (err) {
      console.error("Failed to start speech recognition", err);
      toast.error("Cloud not start voice recording");
    }
  };

  const speak = (text: string) => {
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
  };

  const handleSignIn = async () => {
    try {
      await signIn();
    } catch (err: any) {
      if (err.code === 'auth/unauthorized-domain') {
        const domain = window.location.hostname;
        toast.error("Unauthorized Domain", {
          description: `Add "${domain}" to your Firebase Console under Authentication > Settings > Authorized Domains.`,
          duration: 10000,
        });
      } else {
        toast.error("Sign in failed: " + err.message);
      }
    }
  };

  if (!user) {
    return (
      <div className="flex h-screen bg-[#09090b] items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#18181b] border border-zinc-800 rounded-2xl p-8 text-center space-y-6 shadow-2xl">
          <div className="w-16 h-16 bg-gradient-to-tr from-emerald-500 to-teal-600 rounded-2xl mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Welcome to MyAI</h1>
            <p className="text-zinc-500 mt-2 text-sm">Sign in to start secure, persistent conversations with Gemini 2.0.</p>
          </div>
          <Button 
            onClick={handleSignIn}
            className="w-full bg-white hover:bg-zinc-200 text-black py-6 rounded-xl font-bold flex items-center justify-center gap-3 transition-all"
          >
            <User size={20} />
            Continue with Google
          </Button>
          <p className="text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
            Powered by Google Gemini 2.0 Flash
          </p>
        </div>
      </div>
    );
  }

  const activeChat = chats.find(c => c.id === activeChatId);

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-[#09090b] text-slate-900 dark:text-zinc-100 font-sans transition-colors duration-500">
      <Toaster position="top-right" />
      
      {/* Sidebar - Desktop */}
      <motion.aside 
        id="app-sidebar"
        initial={false}
        animate={{ width: isSidebarOpen ? 256 : 0, opacity: isSidebarOpen ? 1 : 0 }}
        className="hidden md:flex flex-col border-r border-slate-200 dark:border-zinc-800 bg-white dark:bg-[#18181b] overflow-hidden"
      >
        <div className="p-4 flex flex-col h-full">
          <Button 
            onClick={handleNewChat}
            className="w-full flex items-center justify-between px-4 py-3 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:border dark:border-zinc-700 rounded-lg transition-colors text-sm font-medium dark:text-zinc-100"
          >
            <span className="flex items-center gap-2">
              <Plus size={16} />
              New Chat
            </span>
            <kbd className="hidden xl:inline-block text-[10px] bg-white dark:bg-zinc-900 px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500">⌘N</kbd>
          </Button>

          <div className="px-3 py-4 text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Recent Conversations</div>
          
          <ScrollArea className="flex-1 -mx-2 px-2">
            <div className="space-y-1">
              {chats.map(chat => (
                <div
                  key={chat.id}
                  onClick={() => setActiveChatId(chat.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-md text-sm transition-all group relative flex items-center gap-3 cursor-pointer ${
                    activeChatId === chat.id 
                    ? 'bg-zinc-200/50 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border-l-2 border-emerald-500 font-medium' 
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/50 text-slate-500 dark:text-zinc-400'
                  }`}
                >
                  <div className="flex-1 truncate">{chat.title}</div>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteDoc(doc(db, 'chats', chat.id));
                      if (activeChatId === chat.id) setActiveChatId(null);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition-opacity"
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          </ScrollArea>

          <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50 rounded-xl mt-4 space-y-4">
            <div className="space-y-2">
              <label className="text-[10px] text-zinc-500 uppercase font-bold tracking-tight block">Model Selector</label>
              <select 
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-md py-1.5 px-3 text-xs text-zinc-700 dark:text-zinc-300 outline-none ring-1 ring-emerald-500/0 focus:ring-emerald-500 transition-all"
              >
                <option value="gemini-3-flash-preview">Gemini 2.0 Flash</option>
                <option value="gemini-3.1-pro-preview">Gemini 1.5 Pro</option>
                <option value="gemini-3.1-flash-lite-preview">Gemini 2.0 Flash Lite</option>
              </select>
            </div>

            {user ? (
              <DropdownMenu>
                <DropdownMenuTrigger className="w-full text-left">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-8 w-8 ring-1 ring-emerald-500/20">
                      <AvatarImage src={user.photoURL || ''} />
                      <AvatarFallback className="bg-gradient-to-tr from-emerald-500 to-emerald-700 text-white text-xs font-bold">
                        {user.displayName?.charAt(0) || 'U'}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 overflow-hidden">
                      <div className="text-xs font-medium truncate dark:text-zinc-200">{user.displayName || 'John Doe'}</div>
                      <div className="text-[10px] text-zinc-500 truncate">Personal Plan</div>
                    </div>
                  </div>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 rounded-xl">
                  <DropdownMenuItem onClick={signOut} className="text-red-500">
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>Sign out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button onClick={signIn} className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl">
                Sign In
              </Button>
            )}
          </div>
        </div>
      </motion.aside>

      {/* Main Content */}
      <main id="main-content" className="flex-1 flex flex-col relative min-w-0">
        {/* Header */}
        <header id="app-header" className="h-14 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between px-6 bg-white/80 dark:bg-[#09090b]/80 backdrop-blur-md z-10 transition-all">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              className="md:hidden" 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            >
              <Menu size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:flex p-1 w-8 h-8 rounded-md hover:bg-zinc-100 dark:hover:bg-zinc-800"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            >
              {isSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
            </Button>
            <div className="flex items-center gap-3">
              <span className="font-bold tracking-tight text-sm dark:text-zinc-100">MyAI</span>
              {activeChat && (
                <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 text-[10px] font-bold border border-emerald-500/20 uppercase">
                  {activeChat.model.replace('gemini-', '').replace('-latest', '').toUpperCase()}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Sheet>
              <SheetTrigger>
                <div className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md cursor-pointer transition-colors">
                  <Settings size={20} />
                </div>
              </SheetTrigger>
              <SheetContent className="rounded-l-3xl">
                <SheetHeader>
                  <SheetTitle>Settings</SheetTitle>
                </SheetHeader>
                <div className="py-6 space-y-6">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Model</label>
                    <select 
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="w-full p-2 rounded-lg bg-slate-100 dark:bg-slate-800 border-none text-sm"
                    >
                      <option value="gemini-3-flash-preview">Gemini 2.0 Flash</option>
                      <option value="gemini-3.1-pro-preview">Gemini 1.5 Pro</option>
                      <option value="gemini-3.1-flash-lite-preview">Gemini 2.0 Flash Lite</option>
                    </select>
                  </div>
                  <div className="space-y-4">
                    <div className="flex justify-between">
                      <label className="text-sm font-medium">Temperature</label>
                      <span className="text-xs font-mono">{temperature}</span>
                    </div>
                    <Slider 
                      value={[temperature]} 
                      onValueChange={(v) => setTemperature(v[0])} 
                      max={1} 
                      step={0.1} 
                    />
                  </div>
                  <div className="space-y-4">
                    <div className="flex justify-between">
                      <label className="text-sm font-medium">Max Tokens</label>
                      <span className="text-xs font-mono">{maxTokens}</span>
                    </div>
                    <Slider 
                      value={[maxTokens]} 
                      onValueChange={(v) => setMaxTokens(v[0])} 
                      max={4000} 
                      step={100} 
                    />
                  </div>
                </div>
              </SheetContent>
            </Sheet>

            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="rounded-full"
            >
              {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
            </Button>
          </div>
        </header>

        {/* Chat Area */}
        <ScrollArea className="flex-1 p-4">
          <div className="max-w-3xl mx-auto space-y-6 pb-32">
            {!activeChatId && (
              <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
                <div className="p-4 rounded-3xl bg-blue-500/10 text-blue-500 mb-2">
                  <Plus size={48} />
                </div>
                <h2 className="text-3xl font-bold">How can I help you today?</h2>
                <p className="text-slate-500 max-w-sm">
                  Start a new conversation to experience the power of Gemini. 
                  Upload images, use your voice, and get instant answers.
                </p>
                <div className="flex gap-2 flex-wrap justify-center mt-4">
                  {['Write a poem', 'Plan a trip', 'Explain quantum physics', 'Code a React app'].map(prompt => (
                    <Button 
                      key={prompt} 
                      variant="outline" 
                      onClick={() => {
                        setInput(prompt);
                        handleSendMessage();
                      }}
                      className="rounded-full text-xs"
                    >
                      {prompt}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <AnimatePresence initial={false}>
              {messages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[85%] flex items-start gap-4 ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                    <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-bold ${
                      message.role === 'user' 
                      ? 'bg-blue-600 text-white' 
                      : 'bg-gradient-to-tr from-emerald-500 to-teal-600 text-white shadow-lg'
                    }`}>
                      {message.role === 'user' ? (user?.displayName?.charAt(0) || 'U') : (
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>
                      )}
                    </div>
                    
                    <div className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
                      <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed shadow-sm ${
                        message.role === 'user' 
                        ? 'bg-blue-600 text-white rounded-tr-none' 
                        : 'bg-white dark:bg-zinc-900 dark:border dark:border-zinc-800 dark:text-zinc-100 rounded-tl-none shadow-md'
                      }`}>
                        {message.attachment && (
                          <div className="mb-3 max-w-xs overflow-hidden rounded-xl border border-zinc-200/20">
                            <img 
                              src={`data:${message.attachment.mimeType};base64,${message.attachment.data}`} 
                              alt="Attachment"
                              className="w-full object-cover"
                            />
                          </div>
                        )}
                        <div className={`prose prose-sm max-w-none ${message.role === 'user' ? 'prose-invert' : 'dark:prose-invert'}`}>
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-3 mt-2 ml-1">
                        <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-tight">
                          {message.role === 'user' ? 'You' : 'Gemini'} • {message.createdAt?.toDate?.()?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || 'Just now'}
                        </span>
                        {message.role === 'model' && (
                          <button 
                            onClick={() => speak(message.content)}
                            className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-full transition-all text-zinc-400 hover:text-emerald-500"
                          >
                            <Volume2 size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>

            {isTyping && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3 ml-12">
                <span className="text-[10px] font-bold text-zinc-600 dark:text-zinc-600 uppercase tracking-widest">Thinking</span>
                <div className="flex gap-1">
                  <div className="w-1 h-1 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1 h-1 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1 h-1 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </motion.div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Input Area */}
        <div id="input-container" className="absolute bottom-0 left-0 right-0 p-6 pt-0 bg-transparent">
          <div className="max-w-3xl mx-auto">
            {isRecording && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2 mb-2 px-3 py-1.5 bg-red-500/10 border border-red-500/20 rounded-full w-fit mx-auto"
              >
                <div className="flex gap-1 items-end h-4">
                  <motion.div 
                    animate={{ height: [4, 12, 4] }}
                    transition={{ repeat: Infinity, duration: 1, delay: 0 }}
                    className="w-1 bg-red-500 rounded-full"
                  />
                  <motion.div 
                    animate={{ height: [8, 16, 8] }}
                    transition={{ repeat: Infinity, duration: 1, delay: 0.2 }}
                    className="w-1 bg-red-500 rounded-full"
                  />
                  <motion.div 
                    animate={{ height: [4, 12, 4] }}
                    transition={{ repeat: Infinity, duration: 1, delay: 0.4 }}
                    className="w-1 bg-red-500 rounded-full"
                  />
                </div>
                <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Listening...</span>
              </motion.div>
            )}

            {attachment && (
              <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="mb-3 inline-block relative border-2 border-emerald-500 rounded-2xl p-1 bg-zinc-900 group shadow-2xl">
                <img 
                  src={`data:${attachment.mimeType};base64,${attachment.data}`} 
                  className="h-16 w-16 object-cover rounded-xl"
                />
                <button 
                  onClick={() => setAttachment(null)}
                  className="absolute -top-2 -right-2 bg-emerald-600 text-white rounded-full p-1 border-2 border-[#09090b]"
                >
                  <X size={10} />
                </button>
              </motion.div>
            )}
            
            <div className="relative bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 rounded-2xl p-2 shadow-2xl transition-all focus-within:ring-1 focus-within:ring-emerald-500/50">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Message MyAI..."
                rows={1}
                className="w-full bg-transparent border-none text-sm p-3 focus:ring-0 outline-none resize-none text-slate-900 dark:text-zinc-100 placeholder-zinc-500 min-h-[50px] max-h-40"
                style={{ height: 'auto' }}
              />

              <div className="flex items-center justify-between px-3 pb-2 border-t border-slate-100 dark:border-zinc-800 mt-2 pt-2">
                <div className="flex items-center gap-1">
                  <label className="p-2 cursor-pointer text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-all">
                    <ImageIcon size={18} />
                    <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                  </label>
                  
                  <button 
                    onClick={toggleVoice}
                    className={`p-2 rounded-lg transition-all ${isRecording ? 'bg-red-500 text-white' : 'text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10'}`}
                  >
                    <Mic size={18} className={isRecording ? 'animate-pulse' : ''} />
                  </button>
                  
                  <div className="h-4 w-px bg-zinc-800 mx-1"></div>
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider px-2">Temp: {temperature}</span>
                </div>

                <Button 
                  onClick={handleSendMessage}
                  disabled={!input.trim() && !attachment}
                  size="sm"
                  className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl py-1 px-4 h-9 shadow-lg shadow-emerald-900/20 gap-2 transition-all"
                >
                  <span className="text-xs font-bold uppercase">Send</span>
                  <Send size={14} />
                </Button>
              </div>
            </div>
            
            <div className="text-center mt-3">
              <p className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest opacity-60">
                Powered by Gemini 2.0 Flash • Operational
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
