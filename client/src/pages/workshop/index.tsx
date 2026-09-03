import { useEffect, useState } from 'react'
import { View, Text, Input, Image, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { ELEMENTS, ELEMENT_COLORS, ELEMENT_NAMES_ZH } from '../../core/elements'
import type { Element } from '../../core/elements'
import { API_BASE, getJSON, postJSON, uploadImage } from '../../services/api'
import './index.scss'

interface MyPiece {
  id: string
  name: string
  element: string
  imageUrl: string
  status: 'pending' | 'approved' | 'rejected'
  rejectReason?: string | null
}

const STATUS_TEXT: Record<MyPiece['status'], string> = {
  pending: '待审核',
  approved: '已上架',
  rejected: '未通过',
}

export default function Workshop () {
  const [name, setName] = useState('')
  const [element, setElement] = useState<Element>('fire')
  const [imagePath, setImagePath] = useState('')      // 本地临时路径（预览用）
  const [imageUrl, setImageUrl] = useState('')        // 服务端 URL（提交用）
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [mine, setMine] = useState<MyPiece[]>([])
  const [serverDown, setServerDown] = useState(false)

  const loadMine = async () => {
    try {
      setMine(await getJSON<MyPiece[]>('/pieces/mine'))
      setServerDown(false)
    } catch {
      setServerDown(true)
    }
  }

  useEffect(() => { loadMine() }, [])

  const chooseImage = async () => {
    const res = await Taro.chooseImage({ count: 1, sizeType: ['compressed'] })
    const path = res.tempFilePaths[0]
    setImagePath(path)
    setUploading(true)
    try {
      const { url } = await uploadImage(path)
      setImageUrl(url)
      Taro.showToast({ title: '图片已上传', icon: 'success' })
    } catch (e) {
      Taro.showToast({ title: '上传失败，请确认后端已启动', icon: 'none' })
      setImagePath('')
      setImageUrl('')
      setServerDown(true)
      void e
    } finally {
      setUploading(false)
    }
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return Taro.showToast({ title: '请输入棋子名', icon: 'none' })
    if (trimmed.length > 12) return Taro.showToast({ title: '棋子名最多 12 字', icon: 'none' })
    if (!imageUrl) return Taro.showToast({ title: '请先上传棋子图片', icon: 'none' })
    setSubmitting(true)
    try {
      await postJSON('/pieces', { name: trimmed, element, imageUrl })
      Taro.showToast({ title: '已提交待审核', icon: 'success' })
      setName('')
      setImagePath('')
      setImageUrl('')
      await loadMine()
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || '提交失败', icon: 'none' })
    } finally {
      setSubmitting(false)
    }
  }

  const goBack = () => {
    Taro.navigateBack({ fail: () => Taro.reLaunch({ url: '/pages/index/index' }) })
  }

  return (
    <View className='workshop'>
      {/* 顶栏：H5 端没有小程序原生导航栏，需自带返回按钮 */}
      <View className='workshop__topbar'>
        <View className='workshop__back' onClick={goBack}>
          <Text>‹ 返回</Text>
        </View>
        <Text className='workshop__topbar-title'>创作工坊</Text>
      </View>

      {serverDown && (
        <View className='workshop__notice'>
          <Text>无法连接服务器（{API_BASE || '同源服务'}）。当前可正常游玩本地对局，创作功能需先启动后端：server 目录下执行 pnpm run start:dev</Text>
        </View>
      )}

      <View className='panel'>
        <Text className='panel__title'>创作新棋子</Text>

        <View className='form-row'>
          <Text className='form-row__label'>棋子名</Text>
          <Input
            className='form-row__input'
            value={name}
            maxlength={12}
            placeholder='1~12 个字'
            onInput={e => setName(e.detail.value)}
          />
        </View>

        <View className='form-row'>
          <Text className='form-row__label'>属性</Text>
          <View className='form-row__elements'>
            {ELEMENTS.map(el => (
              <View
                key={el}
                className={`el-chip ${element === el ? 'el-chip--on' : ''}`}
                style={`border-color: ${ELEMENT_COLORS[el]}; ${element === el ? `background:${ELEMENT_COLORS[el]}` : ''}`}
                onClick={() => setElement(el)}
              >
                <Text style={element === el ? 'color:#fff' : `color:${ELEMENT_COLORS[el]}`}>
                  {ELEMENT_NAMES_ZH[el]}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <View className='form-row'>
          <Text className='form-row__label'>图片</Text>
          <View className='upload' onClick={chooseImage}>
            {imagePath ? (
              <Image className='upload__img' src={imagePath} mode='aspectFill' />
            ) : (
              <Text className='upload__hint'>{uploading ? '上传中…' : '+ 选择图片'}</Text>
            )}
          </View>
          <Text className='form-row__tip'>png / jpg / webp，≤ 2MB</Text>
        </View>

        <View
          className={`submit-btn ${submitting ? 'submit-btn--disabled' : ''}`}
          onClick={() => { if (!submitting) submit() }}
        >
          <Text>{submitting ? '提交中…' : '提交审核'}</Text>
        </View>
        <Text className='panel__note'>提交后进入待审核队列，审核通过即进入全服公共牌池</Text>
      </View>

      <View className='panel'>
        <Text className='panel__title'>我的棋子</Text>
        {mine.length === 0 && <Text className='panel__empty'>还没有作品，去创作第一只吧</Text>}
        <View className='mine-list'>
          {mine.map(p => (
            <View key={p.id} className='mine-item'>
              <Image
                className='mine-item__img'
                src={`${API_BASE}${p.imageUrl}`}
                mode='aspectFill'
              />
              <View className='mine-item__info'>
                <Text className='mine-item__name'>{p.name}</Text>
                <Text
                  className='mine-item__element'
                  style={`background: ${ELEMENT_COLORS[p.element as Element] ?? '#999'}`}
                >
                  {(ELEMENT_NAMES_ZH as Record<string, string>)[p.element] ?? p.element}
                </Text>
                <Text className={`mine-item__status mine-item__status--${p.status}`}>
                  {STATUS_TEXT[p.status]}
                </Text>
                {p.status === 'rejected' && p.rejectReason && (
                  <Text className='mine-item__reason'>驳回原因：{p.rejectReason}</Text>
                )}
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  )
}
