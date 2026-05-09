export type TradeAnalyticsPoint = {
    date: string
    fullDate: string
    val: number
}

export const calculateCumilitivePnl = (
    data: TradeAnalyticsPoint[],
    // viewMode: 'gross' | 'net',
) => {
    if (!data || data.length === 0) return []
    const sorted = [...data].sort(
        (a, b) => new Date(a.fullDate).getTime() - new Date(b.fullDate).getTime(),
    )
    let cumulative = 0
    return sorted.map(item => {
        cumulative += Number(item.val) || 0
        return { date: item.date, fullDate: item.fullDate, val: cumulative }
    })
}