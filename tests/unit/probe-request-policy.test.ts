import { describe, expect, it } from 'vitest';
import { probeMessagingRequestPolicy } from '../../src/linkedin/probe-request-policy.js';

describe('probe phase-specific messaging request policy', () => {
  const origin = 'https://www.linkedin.com';
  const dash = `${origin}/voyager/api/voyagerMessagingGraphQL/graphql`;
  const target = new Set(['READ']);
  const decide = (phase: 'selection' | 'target', url: string, method = 'GET') =>
    probeMessagingRequestPolicy(phase, method, url, origin, target);

  it('allows only the exact Dash conversation-list GET during selection', () => {
    const hash = 'a'.repeat(32);
    const mailboxUrn = 'urn:li:fsd_profile:SELF';
    expect(decide('selection', `${dash}?queryId=messengerConversations`)).toMatchObject({ allow: true, kind: 'conversation-list' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.${hash}`)).toMatchObject({ allow: true, kind: 'conversation-list' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.${hash}&variables=${encodeURIComponent(`(mailboxUrn:${mailboxUrn},count:20)`)}`)).toMatchObject({ allow: true, kind: 'conversation-list' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.${hash}&variables=${encodeURIComponent(JSON.stringify({ mailboxUrn, count: 20 }))}`)).toMatchObject({ allow: true, kind: 'conversation-list' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.${hash}&mailboxUrn=${encodeURIComponent(mailboxUrn)}`)).toMatchObject({ allow: true, kind: 'conversation-list' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.not-a-hash`)).toMatchObject({ allow: false, kind: 'blocked' });
    expect(decide('target', `${dash}?queryId=messengerConversations&variables=${encodeURIComponent(JSON.stringify({ cursor: 'next' }))}`)).toMatchObject({ allow: true, kind: 'conversation-list' });
    expect(decide('selection', `${dash}?queryId=messengerMessagesByConversation&conversationId=READ`)).toMatchObject({ allow: false, kind: 'blocked' });
    expect(decide('selection', `${dash}?queryId=messengerConversations&conversationId=READ`)).toMatchObject({ allow: false, kind: 'blocked' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.${hash}&variables=${encodeURIComponent(`(mailboxUrn:urn:li:messagingThread:UNREAD,count:20)`)}`)).toMatchObject({ allow: false, kind: 'blocked' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.${hash}&variables=${encodeURIComponent(JSON.stringify({ mailboxUrn: 'urn:li:unknownEntity:SELF' }))}`)).toMatchObject({ allow: false, kind: 'blocked' });
    expect(decide('selection', `${dash}?queryId=messengerConversations.${hash}&variables=${encodeURIComponent(JSON.stringify({ MailboxUrn: mailboxUrn }))}`)).toMatchObject({ allow: false, kind: 'blocked' });
  });

  it('allows target history only when exactly one robustly parsed reference is the target', () => {
    const hash = 'b'.repeat(32);
    const allowed = [
      `${dash}?queryId=messengerMessagesByConversation&conversationId=READ`,
      `${dash}?queryId=messengerMessages.${hash}&conversationId=READ`,
      `${dash}?queryId=messengerMessagesByConversation.${hash}&conversationId=READ`,
      `${dash}?queryId=messengerMessagesByConversation&conversationUrn=${encodeURIComponent('urn:li:messagingThread:READ')}`,
      `${dash}?queryId=messengerConversationMessages&variables=${encodeURIComponent(JSON.stringify({ input: { threadId: 'READ' } }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent('(conversationUrn:urn:li:messagingThread:READ)')}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', conversationUrn: 'urn:li:messagingThread:READ' }))}`,
    ];
    for (const url of allowed) expect(decide('target', url), url).toMatchObject({ allow: true, kind: 'conversation-history' });

    const blocked = [
      `${dash}?queryId=messengerMessagesByConversation`,
      `${dash}?queryId=messengerMessagesByConversation&conversationId=OTHER`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', threadId: 'OTHER' }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', id: 'UNREAD' }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent('(conversationId:READ,ids:(UNREAD))')}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ nested: { conversationId: 'READ', ids: ['UNREAD'] } }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(encodeURIComponent(JSON.stringify({ conversationId: 'READ', ids: ['UNREAD'] })))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', id: { value: 'UNREAD' } }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', candidateId: 'PREFIX-READ-SUFFIX' }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ ConversationId: 'READ' }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'urn:li:fsd_profile:READ' }))}`,
      `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationIdentity: 'READ' }))}`,
    ];
    for (const url of blocked) expect(decide('target', url), url).toMatchObject({ allow: false, kind: 'blocked' });

    const scalarDecoy = decide('target', `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(JSON.stringify({ conversationId: 'READ', id: 'UNREAD' }))}`);
    expect([...scalarDecoy.referencedIds].sort()).toEqual(['READ', 'UNREAD']);
    expect(decide('target', `${dash}?queryId=messengerMessagesByConversation&conversationId=READ&id=PREFIX-READ-SUFFIX`)).toMatchObject({ allow: false });
  });

  it('fails closed for REST, legacy, unknown, case and trailing-path lookalikes', () => {
    const blocked = [
      `${origin}/voyager/api/messaging/conversations/READ/events`,
      `${origin}/voyager/api/messagingV2/conversations/UNREAD/events`,
      `${origin}/voyager/api/graphqlV2?queryId=messengerMessagesByConversation&conversationId=UNREAD`,
      `${origin}/voyager/api/voyagerMessagingGraphQLV2/graphql?queryId=messengerMessagesByConversation&conversationId=UNREAD`,
      `${origin}/voyager/api/voyagerMessagingRest/conversations/UNREAD/events`,
      `${origin}/voyager/api/%6dessagingV2/conversations/UNREAD/events`,
      `${origin}/voyager/api/MESSAGINGcustom/conversations/UNREAD/events`,
      `${origin}/voyager/api/customGraphqlV2?operationName=mailboxMessagesV2`,
      `${origin}/voyager/api/graphql?queryId=messengerMessagesByConversation&conversationId=READ`,
      `${origin}/voyager/api/voyagerMessagingGraphQL/GraphQL?queryId=messengerMessagesByConversation&conversationId=READ`,
      `${dash}/?queryId=messengerMessagesByConversation&conversationId=READ`,
      `${dash}/extra?queryId=messengerMessagesByConversation&conversationId=READ`,
      `${dash}?queryId=MessengerMessagesByConversation&conversationId=READ`,
      `${dash}?QueryId=messengerMessagesByConversation&conversationId=READ`,
      `${dash}?queryId=unknownMessagingRead&conversationId=READ`,
      `${dash}?queryId=messengerMessagesByConversation&conversationId=READ&cursor=opaque`,
      `${origin}/messaging/thread/READ/`,
    ];
    for (const url of blocked) expect(decide('target', url), url).toMatchObject({ messaging: true, allow: false, kind: 'blocked' });
    expect(decide('target', `${dash}?queryId=messengerMessagesByConversation&conversationId=READ`, 'POST')).toMatchObject({ allow: false });
    expect(decide('target', `${origin}/feed/`)).toMatchObject({ messaging: false, allow: false, kind: 'non-messaging' });
    expect(decide('target', `${origin}/voyager/api/profile?queryId=profileView`)).toMatchObject({ messaging: false, allow: false, kind: 'non-messaging' });
    expect(decide('target', `${origin}/voyager/api/profile?profileId=UNREAD`)).toMatchObject({ messaging: true, allow: false, kind: 'blocked' });
  });

  it('finds typed conversation URNs under every decoded unknown value', () => {
    const history = (variables: string) => `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(variables)}`;
    const json = (value: unknown) => history(JSON.stringify(value));
    const foreignSimple = 'urn:li:messagingThread:UNREAD';
    const foreignComposite = 'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,UNREAD)';
    const blocked = [
      json({ conversationId: 'READ', payload: foreignSimple }),
      json({ conversationId: 'READ', payload: foreignComposite }),
      json({ conversationId: 'READ', nested: { value: 'urn:li:messengerConversation:UNREAD' } }),
      json({ conversationId: 'READ', refs: ['urn:li:fsd_profile:MEMBER', 'urn:li:fsd_messengerConversation:UNREAD'] }),
      history(encodeURIComponent(JSON.stringify({ conversationId: 'READ', payload: foreignSimple }))),
      history(`(conversationId:READ,payload:${foreignSimple})`),
      history(`(conversationId:READ,outer:(refs:(${foreignSimple})))`),
    ];
    for (const url of blocked) {
      const decision = decide('target', url);
      expect(decision, url).toMatchObject({ allow: false, kind: 'blocked' });
      expect(decision.referencedIds.has('UNREAD'), url).toBe(true);
    }

    const allowed = [
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread:READ' }),
      json({ conversationId: 'READ', payload: 'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,READ)' }),
      history('(conversationId:READ,payload:urn:li:messagingConversation:READ)'),
      json({
        conversationId: 'READ',
        payload: [
          'urn:li:fsd_profile:UNREAD',
          'urn:li:messagingParticipant:UNREAD',
          'urn:li:messagingMessage:UNREAD',
          'urn:li:mailbox:UNREAD',
        ],
      }),
    ];
    for (const url of allowed) expect(decide('target', url), url).toMatchObject({ allow: true, kind: 'conversation-history' });
  });

  it('rejects malformed and future conversation-family URNs without confusing non-conversation entities', () => {
    const history = (variables: string) => `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(variables)}`;
    const json = (value: unknown) => history(JSON.stringify(value));
    const blocked = [
      json({ conversationId: 'READ', payload: 'urn:li:messagingThreadV2:UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingConversationV2:UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:conversation-v2:UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread:' }),
      json({ conversationId: 'READ', nested: { payload: 'urn%3Ali%3AmessagingThreadV2%3AUNREAD' } }),
      history(encodeURIComponent(JSON.stringify({ conversationId: 'READ', payload: 'urn:li:conversation-v2:UNREAD' }))),
      history('(conversationId:READ,payload:urn:li:messagingConversationV2:UNREAD)'),
      history('(conversationId:READ,outer:(payload:urn:li:messagingThread:))'),
    ];
    for (const url of blocked) expect(decide('target', url), url).toMatchObject({ allow: false, kind: 'blocked' });

    const supportedTargets = [
      'urn:li:messagingThread:READ',
      'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,READ)',
      'urn:li:fsd_messengerConversation:READ',
      'urn:li:messengerConversation:READ',
      'urn:li:messagingConversation:READ',
      'urn:li:conversation:READ',
    ];
    for (const urn of supportedTargets) expect(decide('target', json({ conversationId: 'READ', payload: urn })), urn).toMatchObject({ allow: true, kind: 'conversation-history' });

    expect(decide('target', json({
      conversationId: 'READ',
      payload: [
        'urn:li:profileV2:UNREAD',
        'urn:li:personV2:UNREAD',
        'urn:li:messagingParticipantV2:UNREAD',
        'urn:li:messagingMessageV2:UNREAD',
        'urn:li:messageEventV2:UNREAD',
        'urn:li:mailboxV2:UNREAD',
        'urn:li:inboxV2:UNREAD',
        'urn:li:unknownEntityV2:UNREAD',
      ],
    }))).toMatchObject({ allow: true, kind: 'conversation-history' });
  });

  it('rejects conversation-shaped URNs whose canonical value separator is missing', () => {
    const history = (variables: string) => `${dash}?queryId=messengerMessagesByConversation&variables=${encodeURIComponent(variables)}`;
    const json = (value: unknown) => history(JSON.stringify(value));
    const blocked = [
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread/UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread=UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread?UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThread#UNREAD' }),
      json({ conversationId: 'READ', payload: 'UrN:Li:MeSsAgInGtHrEaD/UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:messagingThreadV3/UNREAD' }),
      json({ conversationId: 'READ', nested: { refs: ['urn%3Ali%3AmessagingThread%2FUNREAD'] } }),
      history(encodeURIComponent(JSON.stringify({ conversationId: 'READ', payload: 'urn:li:messagingThread=UNREAD' }))),
      history('(conversationId:READ,payload:urn:li:messagingThread/UNREAD)'),
      history('(conversationId:READ,outer:(payload:urn%3Ali%3AmessagingThread%3DUNREAD))'),
      history('(conversationId:READ,payload:urn:li:messagingParticipantThread/UNREAD)'),
      json({ conversationId: 'READ', payload: 'prefixurn:li:messagingThread/UNREAD' }),
      json({ conversationId: 'READ', payload: 'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,READ' }),
      json({ conversationId: 'READ', payload: 'urn:li:msg_conversation:(urn:li:fsd_profile:MEMBER,READ)/UNREAD' }),
    ];
    for (const url of blocked) expect(decide('target', url), url).toMatchObject({ allow: false, kind: 'blocked' });

    const ignoredNonConversation = json({
      conversationId: 'READ',
      payload: [
        'urn:li:fsd_profile/UNREAD',
        'urn:li:person=UNREAD',
        'urn:li:messagingParticipant',
        'urn:li:messagingMessageV2/UNREAD',
        'urn:li:messageEventV2=UNREAD',
        'urn:li:mailboxV2/UNREAD',
        'urn:li:inboxV2=UNREAD',
        'urn:li:company/UNREAD',
        'prefixurn:li:fsd_profile/UNREAD',
        'messagingThread is a plain word, not a URN',
      ],
    });
    const benignDecision = decide('target', ignoredNonConversation);
    expect(benignDecision).toMatchObject({ allow: true, kind: 'conversation-history' });
    expect([...benignDecision.referencedIds]).toEqual(['READ']);
    expect(decide('target', json({ conversationId: 'READ', payload: 'urn:li:messagingThread:READ' })))
      .toMatchObject({ allow: true, kind: 'conversation-history' });
  });
});
