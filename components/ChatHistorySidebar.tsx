/**
 * Chat History Sidebar Component
 * 
 * Displays a list of saved conversations for the user.
 * Allows loading previous chats and starting new conversations.
 */

import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    FlatList,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View
} from 'react-native';
import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import {
    ConversationSummary,
    deleteConversation,
    getConversationList
} from '../utils/chatHistory';
import { getSession } from '../utils/supabase';

interface ChatHistorySidebarProps {
    visible: boolean;
    onClose: () => void;
    onLoadConversation: (conversationId: string) => void;
    onNewChat: () => void;
    currentConversationId?: string;
}

export default function ChatHistorySidebar({
    visible,
    onClose,
    onLoadConversation,
    onNewChat,
    currentConversationId,
}: ChatHistorySidebarProps) {
    const { isDark } = useTheme();
    const colors = getThemeColors(isDark);

    const [conversations, setConversations] = useState<ConversationSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    // Load conversations when sidebar opens
    useEffect(() => {
        if (visible) {
            setSearchQuery('');
            loadConversations();
        }
    }, [visible]);

    // Client-side search over title + first message (list is capped at 50).
    const visibleConversations = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return conversations;
        return conversations.filter(c =>
            `${c.title ?? ''} ${c.first_user_message ?? ''}`.toLowerCase().includes(q)
        );
    }, [conversations, searchQuery]);

    const loadConversations = async () => {
        setLoading(true);
        setError(null);

        try {
            const session = await getSession();
            if (!session) {
                setError('Not logged in');
                setLoading(false);
                return;
            }

            const { conversations: convos, error: loadError } = await getConversationList(
                session.user.id
            );

            if (loadError) {
                setError(loadError);
            } else {
                setConversations(convos);
            }
        } catch (err) {
            console.error('Error loading conversations:', err);
            setError('Failed to load conversations');
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteConversation = async (conversationId: string) => {
        const { success, error: deleteError } = await deleteConversation(conversationId);

        if (success) {
            setConversations(prev =>
                prev.filter(c => c.conversation_id !== conversationId)
            );
        } else {
            console.error('Failed to delete conversation:', deleteError);
        }
    };

    const formatDate = (dateString: string): string => {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };

    const truncateMessage = (message: string, maxLength: number = 60): string => {
        if (message.length <= maxLength) return message;
        return message.substring(0, maxLength) + '...';
    };

    const renderConversationItem = ({ item }: { item: ConversationSummary }) => {
        const isActive = item.conversation_id === currentConversationId;

        return (
            <TouchableOpacity
                style={[
                    styles.conversationItem,
                    {
                        backgroundColor: isActive
                            ? colors.primary + '33' // Using primary color with 20% opacity (hex '33')
                            : colors.backgroundSecondary
                    }
                ]}
                onPress={() => {
                    onLoadConversation(item.conversation_id);
                    onClose();
                }}
            >
                <View style={styles.conversationContent}>
                    <Text
                        style={[styles.conversationMessage, { color: colors.text }]}
                        numberOfLines={2}
                    >
                        {item.title?.trim() ||
                            truncateMessage(item.first_user_message || 'New conversation')}
                    </Text>
                    <View style={styles.conversationMeta}>
                        <Text style={[styles.conversationDate, { color: colors.textSecondary }]}>
                            {formatDate(item.last_message_at)}
                        </Text>
                        <Text style={[styles.messageCount, { color: colors.textSecondary }]}>
                            {item.message_count} {item.message_count === 1 ? 'message' : 'messages'}
                        </Text>
                    </View>
                </View>

                <TouchableOpacity
                    style={styles.deleteButton}
                    onPress={() => handleDeleteConversation(item.conversation_id)}
                >
                    <Ionicons name="trash-outline" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
            </TouchableOpacity>
        );
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent={true}
            onRequestClose={onClose}
        >
            <View style={styles.overlay}>
                <Pressable style={styles.overlayTouchable} onPress={onClose} />

                <View style={[styles.sidebar, { backgroundColor: colors.background }]}>
                    {/* Header */}
                    <View style={[styles.header, { borderBottomColor: colors.border }]}>
                        <Text style={[styles.headerTitle, { color: colors.text }]}>
                            Chat History
                        </Text>
                        <TouchableOpacity onPress={onClose}>
                            <Ionicons name="close" size={28} color={colors.text} />
                        </TouchableOpacity>
                    </View>

                    {/* New Chat Button */}
                    <TouchableOpacity
                        style={[styles.newChatButton, { backgroundColor: colors.primary }]}
                        onPress={() => {
                            onNewChat();
                            onClose();
                        }}
                    >
                        <Ionicons name="add-circle-outline" size={22} color="#fff" />
                        <Text style={styles.newChatText}>New Chat</Text>
                    </TouchableOpacity>

                    {/* Search */}
                    {conversations.length > 0 && (
                        <View
                            style={[
                                styles.searchBox,
                                { backgroundColor: colors.backgroundSecondary, borderColor: colors.border },
                            ]}
                        >
                            <Ionicons name="search" size={16} color={colors.textSecondary} />
                            <TextInput
                                style={[styles.searchInput, { color: colors.text }]}
                                value={searchQuery}
                                onChangeText={setSearchQuery}
                                placeholder="Search chats"
                                placeholderTextColor={colors.textSecondary}
                                autoCorrect={false}
                                returnKeyType="search"
                                accessibilityLabel="Search chat history"
                            />
                            {searchQuery.length > 0 && (
                                <TouchableOpacity
                                    onPress={() => setSearchQuery('')}
                                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                    accessibilityLabel="Clear search"
                                >
                                    <Ionicons name="close-circle" size={16} color={colors.textSecondary} />
                                </TouchableOpacity>
                            )}
                        </View>
                    )}

                    {/* Conversation List */}
                    {loading ? (
                        <View style={styles.centerContainer}>
                            <ActivityIndicator size="large" color={colors.primary} />
                        </View>
                    ) : error ? (
                        <View style={styles.centerContainer}>
                            <Text style={[styles.errorText, { color: colors.error }]}>
                                {error}
                            </Text>
                            <TouchableOpacity
                                style={[styles.retryButton, { backgroundColor: colors.primary }]}
                                onPress={loadConversations}
                            >
                                <Text style={styles.retryButtonText}>Retry</Text>
                            </TouchableOpacity>
                        </View>
                    ) : conversations.length === 0 ? (
                        <View style={styles.centerContainer}>
                            <Ionicons name="chatbubbles-outline" size={64} color={colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                                No conversations yet
                            </Text>
                            <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>
                                Start a new chat to begin
                            </Text>
                        </View>
                    ) : visibleConversations.length === 0 ? (
                        <View style={styles.centerContainer}>
                            <Ionicons name="search-outline" size={48} color={colors.textSecondary} />
                            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                                No matching chats
                            </Text>
                        </View>
                    ) : (
                        <FlatList
                            data={visibleConversations}
                            keyExtractor={(item) => item.conversation_id}
                            renderItem={renderConversationItem}
                            contentContainerStyle={styles.listContent}
                            keyboardShouldPersistTaps="handled"
                        />
                    )}
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        flexDirection: 'row',
    },
    overlayTouchable: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    sidebar: {
        width: '80%',
        maxWidth: 320,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
    },
    headerTitle: {
        fontSize: 20,
        fontWeight: '700',
    },
    newChatButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        margin: 16,
        padding: 16,
        borderRadius: 12,
        gap: 8,
    },
    newChatText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '600',
    },
    searchBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 16,
        marginBottom: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
    },
    searchInput: {
        flex: 1,
        fontSize: 14,
        padding: 0,
    },
    listContent: {
        padding: 8,
    },
    conversationItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        marginBottom: 8,
        borderRadius: 12,
    },
    conversationContent: {
        flex: 1,
        gap: 8,
    },
    conversationMessage: {
        fontSize: 14,
        fontWeight: '500',
    },
    conversationMeta: {
        flexDirection: 'row',
        gap: 12,
    },
    conversationDate: {
        fontSize: 12,
    },
    messageCount: {
        fontSize: 12,
    },
    deleteButton: {
        padding: 8,
        marginLeft: 8,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
    },
    errorText: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 16,
    },
    retryButton: {
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 8,
    },
    retryButtonText: {
        color: '#fff',
        fontSize: 14,
        fontWeight: '600',
    },
    emptyText: {
        fontSize: 18,
        fontWeight: '600',
        marginTop: 16,
    },
    emptySubtext: {
        fontSize: 14,
        marginTop: 8,
    },
});
