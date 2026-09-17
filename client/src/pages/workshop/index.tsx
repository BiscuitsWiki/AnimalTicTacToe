import { useEffect, useMemo, useState } from 'react'
import { View, Text, Input, Image, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { ELEMENTS, ELEMENT_COLORS, ELEMENT_NAMES_ZH } from '../../core/elements'
import type { Element } from '../../core/elements'
import { API_BASE, REPORT_REASONS, fetchApprovedPieces, fetchCardByName, getJSON, postJSON, reportPiece, uploadImage, withdrawPiece } from '../../services/api'
import type { ApiCardLookup } from '../../services/api'
import { groupSkinsByCard, toggleElement, elementLabel } from './filter'
import { ensureLogin } from '../../services/auth'
import './index.scss'

interface MyPiece {
  /** 皮肤 id（skinId） */
  id: string
  /** 所属卡牌 id（同名即同一张卡） */
  cardId?: string
  name: string
  element: string
  /** 副属性（可选） */
  element2?: string | null
  imageUrl: string
  status: 'pending' | 'approved' | 'rejected' | 'reported' | 'recycled'
  rejectReason?: string | null
}

const STATUS_TEXT: Record<MyPiece['status'], string> = {
  pending: '待审核',
  approved: '已上架',
  rejected: '未通过',
  reported: '被举报',
  recycled: '已下架',
}

export default function Workshop () {
  const [name, setName] = useState('')
  const [element, setElement] = useState<Element>('fire')
  const [element2, setElement2] = useState<Element | null>(null)   // 副属性（可选）
  const [imagePath, setImagePath] = useState('')      // 本地临时路径（预览用）
  const [imageUrl, setImageUrl] = useState('')        // 服务端 URL（提交用）
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [mine, setMine] = useState<MyPiece[]>([])
  const [approved, setApproved] = useState<MyPiece[]>([])
  const [reportTarget, setReportTarget] = useState<MyPiece | null>(null)
  const [serverDown, setServerDown] = useState(false)
  /** 属性检索：空 = 全部；1 个 = 单属性；2 个 = 双属性组合（无序，主/副任一命中） */
  const [elementFilter, setElementFilter] = useState<string[]>([])
  /** 同名卡命中（同名即同一张卡，属性以卡牌为准） */
  const [cardHit, setCardHit] = useState<ApiCardLookup | null>(null)

  /** 检索 + 按卡牌聚合（同名即同一张卡） */
  const mineGroups = useMemo(() => groupSkinsByCard(mine, elementFilter), [mine, elementFilter])
  const approvedGroups = useMemo(() => groupSkinsByCard(approved, elementFilter), [approved, elementFilter])
  /** 全量卡牌数（标题展示用，不受检索影响） */
  const cardCount = (list: MyPiece[]) => new Set(list.map(p => p.cardId ?? `name:${p.name}`)).size

  const loadMine = async () => {
    try {
      setMine(await getJSON<MyPiece[]>('/pieces/mine'))
      setServerDown(false)
    } catch {
      setServerDown(true)
    }
  }

  const loadApproved = async () => {
    try {
      const list = await fetchApprovedPieces()
      // 保底兜底转换（服务端返回字段与 MyPiece 一致）
      setApproved(list as unknown as MyPiece[])
    } catch {
      // 网络异常时已在 serverDown 提示，静默
    }
  }

  useEffect(() => {
    void (async () => {
      await ensureLogin()
      await Promise.all([loadMine(), loadApproved()])
    })()
  }, [])

  // 名称输入防抖查同名卡：命中即提示"同名即同一张卡"并锁定属性为卡牌属性
  useEffect(() => {
    const trimmed = name.trim()
    if (!trimmed) {
      setCardHit(null)
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      fetchCardByName(trimmed)
        .then(hit => { if (alive) setCardHit(hit) })
        .catch(() => { if (alive) setCardHit(null) })
    }, 300)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [name])

  // 命中同名卡：属性锁定（属性以卡牌为准，避免提交被拒）
  useEffect(() => {
    if (!cardHit) return
    setElement(cardHit.element as Element)
    setElement2((cardHit.element2 as Element | null) ?? null)
  }, [cardHit])

  const chooseImage = async () => {
    // 备份当前图片：取消选择/上传失败时恢复，避免原图被清空
    const prevPath = imagePath
    const prevUrl = imageUrl
    let res: Taro.chooseImage.SuccessCallbackResult | null = null
    try {
      res = await Taro.chooseImage({ count: 1, sizeType: ['compressed'] })
    } catch {
      return // 用户取消选择，保持原图
    }
    const path = res?.tempFilePaths?.[0]
    if (!path) return // 空结果（取消），保持原图
    setImagePath(path)
    setUploading(true)
    try {
      const { url } = await uploadImage(path)
      setImageUrl(url)
      Taro.showToast({ title: '图片已上传', icon: 'success' })
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || '上传失败，请重试', icon: 'none' })
      setImagePath(prevPath)
      setImageUrl(prevUrl)
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
      await postJSON('/pieces', { name: trimmed, element, element2: element2 ?? undefined, imageUrl })
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

  /** 撤回待审核提交 */
  const withdraw = async (id: string) => {
    const { confirm } = await Taro.showModal({
      title: '撤回提交',
      content: '确定撤回该棋子的审核申请吗？撤回后需重新提交。',
    })
    if (!confirm) return
    try {
      await withdrawPiece(id)
      Taro.showToast({ title: '已撤回', icon: 'success' })
      await loadMine()
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || '撤回失败', icon: 'none' })
    }
  }

  /** 提交举报 */
  const doReport = async (reason: string) => {
    if (!reportTarget) return
    try {
      const res = await reportPiece(reportTarget.id, reason)
      Taro.showToast({
        title: res.duplicated
          ? '您已举报过该棋子'
          : res.takedown
            ? '已举报，该棋子将被下架重审'
            : '举报成功，感谢反馈',
        icon: 'none',
      })
      setReportTarget(null)
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || '举报失败', icon: 'none' })
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
          <Text className='form-row__tip'>
            {cardHit
              ? `该名称已有卡牌（${elementLabel(cardHit.element, cardHit.element2)}，已上架 ${cardHit.approvedSkinCount} 款皮肤）：同名即同一张卡，本次将作为它的新皮肤提交，属性已锁定`
              : '同名即同一张卡：提交已存在的名称将作为该卡牌的新皮肤（属性需保持一致）'}
          </Text>
        </View>

        <View className='form-row'>
          <Text className='form-row__label'>属性</Text>
          <View className='form-row__elements'>
            {ELEMENTS.map(el => (
              <View
                key={el}
                className={`el-chip ${element === el ? 'el-chip--on' : ''} ${cardHit ? 'el-chip--locked' : ''}`}
                style={`border-color: ${ELEMENT_COLORS[el]}; ${element === el ? `background:${ELEMENT_COLORS[el]}` : ''}`}
                onClick={() => {
                  if (cardHit) return   // 同名卡属性锁定
                  setElement(el)
                  if (element2 === el) setElement2(null)   // 主属性改选时清掉相同副属性
                }}
              >
                <Text style={element === el ? 'color:#fff' : `color:${ELEMENT_COLORS[el]}`}>
                  {ELEMENT_NAMES_ZH[el]}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <View className='form-row'>
          <Text className='form-row__label'>副属性（可选）</Text>
          <View className='form-row__elements'>
            <View
              className={`el-chip el-chip--none ${element2 === null ? 'el-chip--on' : ''} ${cardHit ? 'el-chip--locked' : ''}`}
              onClick={() => { if (!cardHit) setElement2(null) }}
            >
              <Text>无</Text>
            </View>
            {ELEMENTS.filter(el => el !== element).map(el => (
              <View
                key={el}
                className={`el-chip ${element2 === el ? 'el-chip--on' : ''} ${cardHit ? 'el-chip--locked' : ''}`}
                style={`border-color: ${ELEMENT_COLORS[el]}; ${element2 === el ? `background:${ELEMENT_COLORS[el]}` : ''}`}
                onClick={() => {
                  if (cardHit) return   // 同名卡属性锁定
                  setElement2(element2 === el ? null : el)
                }}
              >
                <Text style={element2 === el ? 'color:#fff' : `color:${ELEMENT_COLORS[el]}`}>
                  {ELEMENT_NAMES_ZH[el]}
                </Text>
              </View>
            ))}
          </View>
          <Text className='form-row__tip'>双属性判定：进攻择优、防守连乘（克制 2x / 抵抗 0.5x，属性关系对齐官方表）</Text>
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

      {/* 属性检索：全部 / 单属性 / 双属性组合（主/副任一命中，组合无序） */}
      <View className='panel'>
        <Text className='panel__title'>属性检索</Text>
        <View className='filter-elements'>
          <View
            className={`el-chip el-chip--none ${elementFilter.length === 0 ? 'el-chip--on' : ''}`}
            onClick={() => setElementFilter([])}
          >
            <Text>全部</Text>
          </View>
          {ELEMENTS.map(el => (
            <View
              key={el}
              className={`el-chip ${elementFilter.includes(el) ? 'el-chip--on' : ''}`}
              style={`border-color: ${ELEMENT_COLORS[el]}; ${elementFilter.includes(el) ? `background:${ELEMENT_COLORS[el]}` : ''}`}
              onClick={() => setElementFilter(toggleElement(elementFilter, el))}
            >
              <Text style={elementFilter.includes(el) ? 'color:#fff' : `color:${ELEMENT_COLORS[el]}`}>
                {ELEMENT_NAMES_ZH[el]}
              </Text>
            </View>
          ))}
        </View>
        <Text className='panel__note'>
          {elementFilter.length === 0
            ? '当前：全部卡牌'
            : elementFilter.length === 1
              ? `当前：含「${elementLabel(elementFilter[0])}」属性的卡牌（主/副任一命中）`
              : `当前：${elementFilter.map(el => elementLabel(el)).join('+')} 组合（选两个属性查双属性卡，无序匹配）`}
        </Text>
      </View>

      <View className='panel'>
        <Text className='panel__title'>我的棋子（{mine.length} 款皮肤 / {cardCount(mine)} 张卡牌）</Text>
        {mine.length === 0 && <Text className='panel__empty'>还没有作品，去创作第一只吧</Text>}
        {mine.length > 0 && mineGroups.length === 0 && (
          <Text className='panel__empty'>没有符合检索条件的棋子</Text>
        )}
        <View className='mine-list'>
          {mineGroups.map(g => (
            <View key={g.key} className='card-group'>
              <View className='card-group__head'>
                <Text className='card-group__name'>{g.name}</Text>
                <View className='mine-item__elements'>
                  {[g.element, ...(g.element2 && g.element2 !== g.element ? [g.element2] : [])].map(el => (
                    <Text
                      key={el}
                      className='mine-item__element'
                      style={`background: ${ELEMENT_COLORS[el as Element] ?? '#999'}`}
                    >
                      {(ELEMENT_NAMES_ZH as Record<string, string>)[el] ?? el}
                    </Text>
                  ))}
                </View>
                <Text className='card-group__count'>{g.skins.length} 款皮肤</Text>
              </View>
              {g.skins.map(p => (
                <View key={p.id} className='mine-item'>
                  <Image
                    className='mine-item__img'
                    src={`${API_BASE}${p.imageUrl}`}
                    mode='aspectFill'
                  />
                  <View className='mine-item__info'>
                    <View className='mine-item__row'>
                      <Text className={`mine-item__status mine-item__status--${p.status}`}>
                        {STATUS_TEXT[p.status]}
                      </Text>
                      {p.status === 'pending' && (
                        <View className='mine-item__btn' onClick={() => withdraw(p.id)}>
                          <Text>撤回</Text>
                        </View>
                      )}
                    </View>
                    {p.status === 'rejected' && p.rejectReason && (
                      <Text className='mine-item__reason'>驳回原因：{p.rejectReason}</Text>
                    )}
                  </View>
                </View>
              ))}
            </View>
          ))}
        </View>
      </View>

      {/* 已上架皮肤（全服公共池，按卡牌聚合，可直接查看/举报） */}
      <View className='panel'>
        <Text className='panel__title'>
          已上架卡牌（{approved.length} 款皮肤 / {cardCount(approved)} 张卡牌）
        </Text>
        {approved.length === 0 && <Text className='panel__empty'>暂无已上架卡牌</Text>}
        {approved.length > 0 && approvedGroups.length === 0 && (
          <Text className='panel__empty'>没有符合检索条件的卡牌</Text>
        )}
        <View className='mine-list'>
          {approvedGroups.map(g => (
            <View key={g.key} className='card-group'>
              <View className='card-group__head'>
                <Text className='card-group__name'>{g.name}</Text>
                <View className='mine-item__elements'>
                  {[g.element, ...(g.element2 && g.element2 !== g.element ? [g.element2] : [])].map(el => (
                    <Text
                      key={el}
                      className='mine-item__element'
                      style={`background: ${ELEMENT_COLORS[el as Element] ?? '#999'}`}
                    >
                      {(ELEMENT_NAMES_ZH as Record<string, string>)[el] ?? el}
                    </Text>
                  ))}
                </View>
                <Text className='card-group__count'>{g.skins.length} 款皮肤</Text>
              </View>
              {g.skins.map(p => (
                <View key={p.id} className='mine-item mine-item--public'>
                  <Image
                    className='mine-item__img'
                    src={`${API_BASE}${p.imageUrl}`}
                    mode='aspectFill'
                  />
                  <View className='mine-item__info'>
                    <View className='mine-item__row'>
                      <Text className='mine-item__name'>{p.name}</Text>
                    </View>
                  </View>
                  <View className='mine-item__report' onClick={() => setReportTarget(p)}>
                    <Text>举报</Text>
                  </View>
                </View>
              ))}
            </View>
          ))}
        </View>
      </View>

      {/* 举报弹窗 */}
      {reportTarget && (
        <View className='mask' onClick={() => setReportTarget(null)}>
          <View className='mask__panel' onClick={e => e.stopPropagation()}>
            <Text className='mask__title'>举报「{reportTarget.name}」</Text>
            <Text className='mask__desc'>该棋子将进入人工复核，请选择举报理由</Text>
            <View className='report__grid'>
              {REPORT_REASONS.map(r => (
                <View key={r.value} className='report__item' onClick={() => doReport(r.value)}>
                  <Text>{r.label}</Text>
                </View>
              ))}
            </View>
            <View className='report__cancel' onClick={() => setReportTarget(null)}>
              <Text>取消</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  )
}
