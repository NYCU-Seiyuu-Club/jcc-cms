(function () {
  const TAIPEI_OFFSET = '+08:00';
  const MINIMUM_LEAD_MINUTES = 10;
  const MINIMUM_LEAD_MS = MINIMUM_LEAD_MINUTES * 60 * 1000;

  function parseTimestamp(value) {
    if (!value) return null;
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  function toTaipeiInput(value) {
    const timestamp = parseTimestamp(value);
    if (!timestamp) return '';
    const taipeiClock = new Date(timestamp.getTime() + 8 * 60 * 60 * 1000);
    return taipeiClock.toISOString().slice(0, 16);
  }

  function fromTaipeiInput(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return '';
    const timestamp = new Date(`${value}:00${TAIPEI_OFFSET}`);
    return Number.isNaN(timestamp.getTime()) ? '' : timestamp.toISOString();
  }

  function earliestScheduleValue(now) {
    const earliest = new Date(now.getTime() + MINIMUM_LEAD_MS);
    earliest.setUTCSeconds(0, 0);
    if (earliest.getTime() < now.getTime() + MINIMUM_LEAD_MS) {
      earliest.setUTCMinutes(earliest.getUTCMinutes() + 1);
    }
    return toTaipeiInput(earliest);
  }

  const PublishScheduleControl = createClass({
    getInitialState() {
      const timestamp = parseTimestamp(this.props.value);
      const isScheduled = timestamp && timestamp.getTime() > Date.now();
      return {
        mode: isScheduled ? 'scheduled' : 'immediate',
        scheduledValue: isScheduled ? toTaipeiInput(timestamp) : '',
      };
    },

    componentDidMount() {
      if (!parseTimestamp(this.props.value)) {
        this.props.onChange(new Date().toISOString());
      }
    },

    componentDidUpdate(previousProps) {
      if (previousProps.value === this.props.value) return;
      const timestamp = parseTimestamp(this.props.value);
      if (!timestamp) return;

      if (timestamp.getTime() > Date.now()) {
        const scheduledValue = toTaipeiInput(timestamp);
        if (this.state.mode !== 'scheduled' || this.state.scheduledValue !== scheduledValue) {
          this.setState({ mode: 'scheduled', scheduledValue });
        }
      }
    },

    handleModeChange(event) {
      const mode = event.target.value;
      if (mode === 'immediate') {
        this.setState({ mode: 'immediate', scheduledValue: '' });
        this.props.onChange(new Date().toISOString());
        return;
      }

      const scheduledValue = earliestScheduleValue(new Date());
      this.setState({ mode: 'scheduled', scheduledValue });
      this.props.onChange(fromTaipeiInput(scheduledValue));
    },

    handleScheduleChange(event) {
      const scheduledValue = event.target.value;
      this.setState({ scheduledValue });
      this.props.onChange(fromTaipeiInput(scheduledValue));
    },

    isValid() {
      const timestamp = parseTimestamp(this.props.value);
      if (!timestamp) {
        return { error: { message: '請設定有效的發布時間。' } };
      }
      if (this.state.mode === 'scheduled' && timestamp.getTime() < Date.now() + MINIMUM_LEAD_MS) {
        return { error: { message: `排程發布須至少提前 ${MINIMUM_LEAD_MINUTES} 分鐘。` } };
      }
      return true;
    },

    render() {
      const h = window.h;
      const wrapperClass = this.props.classNameWrapper;
      const earliest = earliestScheduleValue(new Date());
      const publishedAt = parseTimestamp(this.props.value);

      return h(
        'div',
        { className: wrapperClass },
        h(
          'label',
          { htmlFor: `${this.props.forID}-mode`, style: { display: 'block', marginBottom: '8px', fontWeight: 600 } },
          '發布方式',
        ),
        h(
          'select',
          {
            id: `${this.props.forID}-mode`,
            value: this.state.mode,
            onChange: this.handleModeChange,
            style: {
              width: '100%',
              minHeight: '42px',
              marginBottom: '12px',
              padding: '8px 12px',
              border: '1px solid #b3b9c4',
              borderRadius: '4px',
              background: '#fff',
            },
          },
          h('option', { value: 'immediate' }, '立即發布'),
          h('option', { value: 'scheduled' }, '排程發布'),
        ),
        this.state.mode === 'scheduled'
          ? h(
              'div',
              null,
              h(
                'label',
                {
                  htmlFor: `${this.props.forID}-datetime`,
                  style: { display: 'block', marginBottom: '8px', fontWeight: 600 },
                },
                '發布時間（Asia/Taipei）',
              ),
              h('input', {
                id: `${this.props.forID}-datetime`,
                type: 'datetime-local',
                value: this.state.scheduledValue,
                min: earliest,
                onChange: this.handleScheduleChange,
                style: {
                  width: '100%',
                  minHeight: '42px',
                  padding: '8px 12px',
                  border: '1px solid #b3b9c4',
                  borderRadius: '4px',
                },
              }),
              h(
                'p',
                { style: { marginTop: '8px', color: '#68758a', fontSize: '13px' } },
                `須至少提前 ${MINIMUM_LEAD_MINUTES} 分鐘，時間到後網站會自動顯示。`,
              ),
            )
          : h(
              'p',
              { style: { margin: 0, color: '#68758a', fontSize: '13px' } },
              publishedAt ? `發布時間：${toTaipeiInput(publishedAt).replace('T', ' ')}（台北）` : '儲存後立即發布。',
            ),
      );
    },
  });

  CMS.registerWidget('publish-schedule', PublishScheduleControl);

  window.JCCPublishSchedule = {
    fromTaipeiInput,
    toTaipeiInput,
    earliestScheduleValue,
  };
})();
