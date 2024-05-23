// @ts-nocheck

/* eslint-disable jsx-a11y/alt-text */
/* eslint-disable @next/next/no-img-element */
import 'server-only'

import {
  createAI,
  createStreamableUI,
  getMutableAIState,
  getAIState,
  createStreamableValue
} from 'ai/rsc'

import { nanoid, sleep } from '@/lib/utils'
import { saveChat } from '@/app/actions'
import { SpinnerMessage, UserMessage, BotCard, BotMessage } from '@/components/message'
import { Chat } from '../types'
import { auth } from '@/auth'
import { CheckIcon, SpinnerIcon } from '@/components/ui/icons'
import { format } from 'date-fns'
import { experimental_streamText } from 'ai'
import { google } from 'ai/google'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { z } from 'zod'
import { Video } from '@/components/video'
import { rateLimit } from './ratelimit'

const genAI = new GoogleGenerativeAI(
  process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
)

async function describeImage(imageBase64: string) {
  'use server'

  await rateLimit()

  const aiState = getMutableAIState()
  const spinnerStream = createStreamableUI(<SpinnerMessage />)
  const messageStream = createStreamableUI(null)
  const uiStream = createStreamableUI()

  ;(async () => {
    try {
      // (index 0) metadata, (index 1) actual image data.
      const imageData = imageBase64.split(',')[1]

      // data:image/png;base64, ... base64 image data ... Extract mimetype
      const imageMimeType = imageBase64.split(',')[0].split(':')[1].split(';')[0]

      const model = genAI.getGenerativeModel({ model: 'gemini-pro-vision' })
      const prompt = 'Describe this photo.'
      const image = {
        inlineData: {
          data: imageData,
          mimeType: imageMimeType
        }
      }

      /* 
      const filePart = {inline_data: {data: imageData, mimeType: imageMimeType}}
      const textPart = {text: 'What is this picture about?'}
      const request = {
        contents: [{role: 'user', parts: [textPart, filePart]}],
      } */
  

      const result = await model.generateContentStream([prompt, image])

      let textContent = ''
      spinnerStream.done(null)

      for await (const delta of result.stream) {
        const { textDelta = '' } = delta

        textContent += textDelta

        console.log("describeImage: " + textContent)

        messageStream.update(<BotMessage content={textContent} />)
      }
      // console.log("describeImage: " + textContent)

      console.log("describeImage.done: " + textContent)

      uiStream.update(
        <BotCard>
          <img src={`${imageBase64}`} />
        </BotCard>
      )
      spinnerStream.done(null)
      messageStream.done(null)

      aiState.update({
        ...aiState.get(),
        messages: [
          ...aiState.get().messages,
          {
            id: nanoid(),
            role: 'assistant',
            content: textContent
          }
        ]
      })

      /* aiState.done({
        ...aiState.get(),
        interactions: [textContent]
      }) */
    } catch (e) {
      console.error(e)

      const error = new Error(
        'The AI got rate limited, please try again later.'
      )
      uiStream.error(error)
      spinnerStream.error(error)
      messageStream.error(error)
      aiState.done()
    }
  })()

  return {
    id: nanoid(),
    attachments: uiStream.value,
    spinner: spinnerStream.value,
    display: messageStream.value
  }
}

async function submitUserMessage(content: string) {
  'use server'

  await rateLimit()

  const aiState = getMutableAIState()

  aiState.update({
    ...aiState.get(),
    messages: [
      ...aiState.get().messages,
      {
        id: nanoid(),
        role: 'user',
        content: `${aiState.get().interactions.join('\n\n')}\n\n${content}`
      }
    ]
  })

  const history = aiState.get().messages.map(message => ({
    role: message.role,
    content: message.content
  }))
  // console.log("history: " + history)

  // const textStream = createStreamableValue('')
  const spinnerStream = createStreamableUI(<SpinnerMessage />)
  const messageStream = createStreamableUI(null)
  const uiStream = createStreamableUI()

  ;(async () => {
    try {
      const result = await experimental_streamText({
        model: google.generativeAI('models/gemini-1.5-flash-latest'),
        temperature: 0.3,
        system: `You are a helpful assistant.`,
        messages: [...history]
      })

      let textContent = ''
      spinnerStream.done(null)

      for await (const delta of result.fullStream) {
        const { textDelta = '' } = delta

        textContent += textDelta

        console.log("submitUserMessage: " + textContent)

        messageStream.update(<BotMessage content={textContent} />)
      }
      
      // console.log("submitUserMessage.done: " + textContent)
      // messageStream.update(<BotMessage content={textContent} />)

      aiState.update({
        ...aiState.get(),
        messages: [
          ...aiState.get().messages,
          {
            id: nanoid(),
            role: 'assistant',
            content: textContent
          }
        ]
      })

      uiStream.done()
      // textStream.done()
      messageStream.done()
    } catch (e) {
      console.error(e)

      const error = new Error(
        'The AI got rate limited, please try again later.'
      )
      uiStream.error(error)
      // textStream.error(error)
      messageStream.error(error)
      aiState.done()
    }
  })()

  return {
    id: nanoid(),
    attachments: uiStream.value,
    spinner: spinnerStream.value,
    display: messageStream.value
  }
}

export type Message = {
  role: 'user' | 'assistant' | 'system' | 'function' | 'data' | 'tool'
  content: string
  id?: string
  name?: string
  display?: {
    name: string
    props: Record<string, any>
  }
}

export type AIState = {
  chatId: string
  interactions?: string[]
  messages: Message[]
}

export type UIState = {
  id: string
  display: React.ReactNode
  spinner?: React.ReactNode
  attachments?: React.ReactNode
}[]

export const AI = createAI<AIState, UIState>({
  actions: {
    submitUserMessage,
    describeImage
  },
  initialUIState: [],
  initialAIState: { chatId: nanoid(), interactions: [], messages: [] },
  unstable_onGetUIState: async () => {
    'use server'

    const session = await auth()

    if (session && session.user) {
      const aiState = getAIState()

      if (aiState) {
        const uiState = getUIStateFromAIState(aiState)
        return uiState
      }
    } else {
      return
    }
  },
  unstable_onSetAIState: async ({ state }) => {
    'use server'

    const session = await auth()

    if (session && session.user) {
      const { chatId, messages } = state

      const createdAt = new Date()
      const userId = session.user.id as string
      const path = `/chat/${chatId}`
      const title = messages[0].content.substring(0, 100)

      const chat: Chat = {
        id: chatId,
        title,
        userId,
        createdAt,
        messages,
        path
      }

      await saveChat(chat)
    } else {
      return
    }
  }
})

export const getUIStateFromAIState = (aiState: Chat) => {
  return aiState.messages
    .filter(message => message.role !== 'system')
    .map((message, index) => ({
      id: `${aiState.chatId}-${index}`,
      display:
        message.role === 'assistant' ? (
            <BotMessage content={message.content} />
        ) : message.role === 'user' ? (
          <UserMessage showAvatar>{message.content}</UserMessage>
        ) : (
          <BotMessage content={message.content} />
        )
    }))
}
